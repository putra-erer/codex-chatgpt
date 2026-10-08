import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractShapefile } from "@/server/processing/archive";
import { cleanupUpload, createUploadDirectory, receiveShapefileUpload, uploadDirectory } from "@/server/storage/local";
import * as configuration from "@/server/processing/config";
import { shapefileEntries, zipFixture, type ZipFixtureEntry } from "./helpers/zip-fixture";

let temporary: string;
beforeEach(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), "gis-archive-test-"));
  vi.stubEnv("GIS_STORAGE_ROOT", path.join(temporary, "private"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(temporary, { recursive: true, force: true });
});

async function extract(entries: ZipFixtureEntry[]) {
  const archive = path.join(temporary, `${randomUUID()}.zip`);
  const destination = path.join(temporary, randomUUID());
  await writeFile(archive, zipFixture(entries));
  return { archive, destination, result: extractShapefile(archive, destination) };
}

async function rejected(entries: ZipFixtureEntry[], code?: string) {
  const attempt = await extract(entries);
  await expect(attempt.result).rejects.toMatchObject(code ? { code } : { name: "GISProcessingError" });
  await expect(stat(attempt.destination)).rejects.toMatchObject({ code: "ENOENT" });
}

function uploadRequest(data = zipFixture(shapefileEntries()), fields: [string, string][] = [["name", "Parcel boundaries"]]) {
  const form = new FormData();
  for (const [name, value] of fields) form.append(name, value);
  form.append("file", new Blob([new Uint8Array(data)], { type: "application/octet-stream" }), "untrusted-name.bin");
  return new Request("http://localhost/api/admin/layers/upload", { method: "POST", body: form });
}

describe("bounded Shapefile ZIP extraction", () => {
  it("extracts one nested dataset with private permissions, normalized case and optional encoding", async () => {
    const attempt = await extract([
      { name: "Folder/", data: "", mode: 0o040700 },
      ...shapefileEntries("Folder/Parcels").map((entry, index) => ({ ...entry, name: index === 1 ? "folder/PARCELS.SHX" : entry.name, deflate: true })),
      { name: "Folder/Parcels.cpg", data: "UTF-8" },
      { name: "Folder/Parcels.qix", data: "index" },
    ]);
    const result = await attempt.result;
    expect(result.shpPath).toBe(path.join(attempt.destination, "folder/parcels.shp"));
    expect(await readFile(result.prjPath, "utf8")).toBe("fixture prj");
    expect(await readFile(result.cpgPath!, "utf8")).toBe("UTF-8");
    expect((await stat(attempt.destination)).mode & 0o777).toBe(0o700);
    expect((await stat(result.shpPath)).mode & 0o777).toBe(0o600);
  });

  it.each(["shp", "shx", "dbf", "prj"])("requires the .%s component", async (extension) => {
    await rejected(shapefileEntries().filter((entry) => !entry.name.endsWith(`.${extension}`)), `MISSING_${extension.toUpperCase()}`);
  });

  it("rejects multiple datasets and sidecars with a mismatched name or folder", async () => {
    await rejected([...shapefileEntries(), { name: "other.shp" }], "MULTIPLE_SHAPEFILES");
    await rejected(shapefileEntries().map((entry) => entry.name.endsWith(".prj") ? { ...entry, name: "other/dataset.prj" } : entry), "MULTIPLE_SHAPEFILES");
  });

  it.each(["../dataset.shp", "/dataset.shp", "folder/../../dataset.shp", "folder\\dataset.shp", "C:/dataset.shp", ".hidden/dataset.shp", "folder/./dataset.shp", "folder//dataset.shp", "dataset.shp:alternate"])("rejects unsafe path %s", async (name) => {
    await rejected([{ name }, ...shapefileEntries().slice(1)]);
    await expect(stat(path.join(temporary, "dataset.shp"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["other.zip", "README.txt", "run.sh", "image.tif", "image.shp.exe"])("rejects unrelated or nested content %s", async (name) => {
    await rejected([...shapefileEntries(), { name }], "UNSAFE_ARCHIVE");
  });

  it("rejects symlinks, special files, encryption, duplicate entries and case collisions", async () => {
    await rejected([{ name: "dataset.shp", mode: 0o120777 }, ...shapefileEntries().slice(1)], "UNSAFE_ARCHIVE");
    await rejected([{ name: "dataset.shp", mode: 0o010600 }, ...shapefileEntries().slice(1)], "UNSAFE_ARCHIVE");
    // Yauzl can reject malformed encryption headers before our entry validation.
    await rejected([{ name: "dataset.shp", flags: 1 }, ...shapefileEntries().slice(1)]);
    await rejected([...shapefileEntries(), { name: "dataset.shp" }], "UNSAFE_ARCHIVE");
    await rejected([...shapefileEntries(), { name: "DATASET.SHP" }], "UNSAFE_ARCHIVE");
  });

  it("checks CRC and decompressed sizes and rejects corrupt or empty archives", async () => {
    await rejected([{ name: "dataset.shp", checksum: 123 }, ...shapefileEntries().slice(1)], "INVALID_ARCHIVE");
    await rejected([{ name: "dataset.shp", deflate: true, declaredSize: 8 }, ...shapefileEntries().slice(1)], "INVALID_ARCHIVE");
    await rejected([{ name: "dataset.shp", data: "" }, ...shapefileEntries().slice(1)], "INVALID_ARCHIVE");
    await rejected([], "INVALID_ARCHIVE");
    const bad = path.join(temporary, "corrupt.zip");
    await writeFile(bad, Buffer.alloc(200));
    await expect(extractShapefile(bad, path.join(temporary, "out"))).rejects.toMatchObject({ code: "INVALID_ARCHIVE" });
  });

  it("bounds entry count, each file, total extracted bytes and compression ratio", async () => {
    await rejected(Array.from({ length: 33 }, (_, index) => ({ name: `file${index}.shp` })), "ARCHIVE_LIMIT");
    const original = configuration.gisLimits();
    vi.spyOn(configuration, "gisLimits").mockReturnValue({ ...original, maxEntryBytes: 10 });
    await rejected(shapefileEntries(), "ARCHIVE_LIMIT");
    vi.spyOn(configuration, "gisLimits").mockReturnValue({ ...original, maxExtractBytes: 30 });
    await rejected(shapefileEntries(), "ARCHIVE_LIMIT");
    vi.spyOn(configuration, "gisLimits").mockReturnValue(original);
    await rejected([{ name: "dataset.shp", data: Buffer.alloc(100_000), deflate: true }, ...shapefileEntries().slice(1)], "ARCHIVE_LIMIT");
  });

  it("never overwrites an existing destination or follows a symlinked parent", async () => {
    const attempt = await extract(shapefileEntries());
    await attempt.result;
    await expect(extractShapefile(attempt.archive, attempt.destination)).rejects.toMatchObject({ code: "INVALID_ARCHIVE" });
    expect(await readFile(path.join(attempt.destination, "dataset.shp"), "utf8")).toBe("fixture shp");
    const linked = path.join(temporary, "linked");
    await symlink(attempt.destination, linked);
    await expect(extractShapefile(attempt.archive, path.join(linked, "outside"))).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    await expect(stat(path.join(attempt.destination, "outside"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("private streamed upload storage", () => {
  it("streams a ZIP regardless of untrusted MIME/name and returns bounded metadata", async () => {
    const id = randomUUID();
    const data = zipFixture(shapefileEntries());
    const result = await receiveShapefileUpload(uploadRequest(data, [["name", " Parcels "], ["description", "Boundaries"], ["isVisible", "false"]]), id);
    expect(result.fields).toEqual({ name: "Parcels", description: "Boundaries", isVisible: false });
    expect(result.zipPath).toBe(path.join(uploadDirectory(id), "archive.zip"));
    expect(await readFile(result.zipPath)).toEqual(data);
    expect((await stat(uploadDirectory(id))).mode & 0o777).toBe(0o700);
    expect((await stat(result.zipPath)).mode & 0o777).toBe(0o600);
    await cleanupUpload(id);
    await expect(stat(uploadDirectory(id))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("defaults visibility to true and protects existing upload directories", async () => {
    const id = randomUUID();
    const result = await receiveShapefileUpload(uploadRequest(), id);
    expect(result.fields.isVisible).toBe(true);
    await expect(receiveShapefileUpload(uploadRequest(), id)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    expect(await readFile(result.zipPath)).toEqual(zipFixture(shapefileEntries()));
  });

  it.each(([
    [], [["name", ""]], [["name", "a"], ["name", "b"]], [["name", "a"], ["isVisible", "yes"]],
    [["name", "a"], ["unexpected", "field"]], [["name", "a".repeat(201)]], [["name", "a"], ["description", "b".repeat(2001)]],
  ] as [string, string][][]).map((fields) => ({ fields })))("rejects invalid metadata and removes partial storage ($fields)", async ({ fields }) => {
    const id = randomUUID();
    await expect(receiveShapefileUpload(uploadRequest(undefined, fields), id)).rejects.toMatchObject({ code: "INVALID_METADATA" });
    await expect(stat(uploadDirectory(id))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects non-ZIP content, missing files and duplicate file parts", async () => {
    let id = randomUUID();
    await expect(receiveShapefileUpload(uploadRequest(Buffer.from("not a ZIP")), id)).rejects.toMatchObject({ code: "INVALID_ARCHIVE" });
    await expect(stat(uploadDirectory(id))).rejects.toMatchObject({ code: "ENOENT" });
    const empty = new FormData();
    empty.append("name", "Layer");
    id = randomUUID();
    await expect(receiveShapefileUpload(new Request("http://localhost", { method: "POST", body: empty }), id)).rejects.toMatchObject({ code: "INVALID_UPLOAD" });
    const doubled = new FormData();
    doubled.append("name", "Layer");
    for (let i = 0; i < 2; i++) doubled.append("file", new Blob([new Uint8Array(zipFixture(shapefileEntries()))]), "data.zip");
    id = randomUUID();
    await expect(receiveShapefileUpload(new Request("http://localhost", { method: "POST", body: doubled }), id)).rejects.toMatchObject({ code: "INVALID_UPLOAD" });
    expect(await readdir(path.join(temporary, "private"))).toEqual([]);
  });

  it("bounds actual bytes even without Content-Length and rejects oversized declarations", async () => {
    const original = configuration.gisLimits();
    vi.spyOn(configuration, "gisLimits").mockReturnValue({ ...original, maxUploadBytes: 100 });
    const id = randomUUID();
    await expect(receiveShapefileUpload(uploadRequest(), id)).rejects.toMatchObject({ code: "UPLOAD_TOO_LARGE" });
    await expect(stat(uploadDirectory(id))).rejects.toMatchObject({ code: "ENOENT" });
    const request = uploadRequest();
    request.headers.set("content-length", "1000000");
    await expect(receiveShapefileUpload(request, randomUUID())).rejects.toMatchObject({ code: "UPLOAD_TOO_LARGE" });
  });

  it("times out stalled request bodies and removes incomplete uploads", async () => {
    const original = configuration.gisLimits();
    vi.spyOn(configuration, "gisLimits").mockReturnValue({ ...original, processTimeoutMs: 30 });
    const request = new Request("http://localhost", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=stall" }, body: new ReadableStream(), duplex: "half" } as RequestInit);
    const id = randomUUID();
    await expect(receiveShapefileUpload(request, id)).rejects.toMatchObject({ code: "UPLOAD_TIMEOUT" });
    await expect(stat(uploadDirectory(id))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects traversal IDs, public storage and symlinked storage ancestors", async () => {
    expect(() => uploadDirectory("../escape")).toThrow();
    vi.stubEnv("GIS_STORAGE_ROOT", path.resolve("public/uploads"));
    await expect(createUploadDirectory(randomUUID())).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    const linked = path.join(temporary, "linked");
    await symlink(temporary, linked);
    vi.stubEnv("GIS_STORAGE_ROOT", path.join(linked, "private"));
    await expect(createUploadDirectory(randomUUID())).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    await expect(stat(path.join(temporary, "private"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
