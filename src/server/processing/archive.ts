import { createWriteStream } from "node:fs";
import { lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32 } from "node:zlib";
import * as yauzl from "yauzl";
import { gisLimits } from "@/server/processing/config";
import { GISProcessingError } from "@/server/processing/errors";

const allowedExtensions = new Set([".shp", ".shx", ".dbf", ".prj", ".cpg", ".sbn", ".sbx", ".qix", ".fix", ".ain", ".aih", ".ixs", ".mxs", ".shp.xml"]);

function safeEntry(entry: yauzl.Entry) {
  const name = entry.fileName;
  const directory = name.endsWith("/");
  const parts = (directory ? name.slice(0, -1) : name).split("/");
  const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
  if (
    !name || name.length > 1024 || name.includes("\\") || name.includes(":") ||
    /[\u0000-\u001f\u007f]/.test(name) || path.posix.isAbsolute(name) ||
    parts.some((part) => !part || part.startsWith(".")) ||
    (unixType !== 0 && unixType !== (directory ? 0o040000 : 0o100000)) ||
    (entry.generalPurposeBitFlag & 0x41) !== 0 ||
    ![0, 8].includes(entry.compressionMethod)
  ) throw new GISProcessingError("UNSAFE_ARCHIVE");
  const canonical = parts.map((part) => part.normalize("NFC").toLowerCase()).join("/");
  if (directory) {
    if (entry.uncompressedSize !== 0) throw new GISProcessingError("UNSAFE_ARCHIVE");
    return { name, canonical, directory, extension: "", basename: "" };
  }
  const extension = canonical.endsWith(".shp.xml") ? ".shp.xml" : path.posix.extname(canonical);
  if (!allowedExtensions.has(extension)) throw new GISProcessingError("UNSAFE_ARCHIVE");
  const basename = canonical.slice(0, -extension.length);
  if (!path.posix.basename(basename)) throw new GISProcessingError("UNSAFE_ARCHIVE");
  return { name, canonical, directory, extension, basename };
}

/** Extract exactly one dataset into a new, private directory. No archive paths are trusted. */
export async function extractShapefile(zipPath: string, destination: string): Promise<{
  shpPath: string;
  prjPath: string;
  cpgPath?: string;
}> {
  const limits = gisLimits();
  const root = path.resolve(destination);
  let zip: yauzl.ZipFile | undefined;
  let created = false;
  let active: Promise<void> = Promise.resolve();
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const files = new Map<string, string>();
  const basenames = new Set<string>();
  let succeeded = false;
  try {
    const archiveInfo = await lstat(zipPath);
    if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || archiveInfo.size < 22) throw new GISProcessingError("INVALID_ARCHIVE");
    if (archiveInfo.size > limits.maxUploadBytes) throw new GISProcessingError("UPLOAD_TOO_LARGE");
    let parent = path.parse(root).root;
    for (const component of path.dirname(root).slice(parent.length).split(path.sep).filter(Boolean)) {
      parent = path.join(parent, component);
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new GISProcessingError("STORAGE_ERROR");
    }
    await mkdir(root, { mode: 0o700 });
    created = true;
    zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
      yauzl.open(zipPath, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true }, (error, opened) => {
        if (error) reject(new GISProcessingError("INVALID_ARCHIVE"));
        else resolve(opened);
      });
    });
    if (!zip.entryCount) throw new GISProcessingError("INVALID_ARCHIVE");
    if (zip.entryCount > limits.maxEntries) throw new GISProcessingError("ARCHIVE_LIMIT");
    const archive = zip;
    const seen = new Set<string>();
    let entries = 0;
    let declaredTotal = 0;
    let actualTotal = 0;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        abort.abort();
        archive.close();
        reject(error instanceof GISProcessingError ? error : new GISProcessingError("INVALID_ARCHIVE"));
      };
      timer = setTimeout(() => fail(new GISProcessingError("PROCESS_TIMEOUT")), limits.processTimeoutMs);
      timer.unref();
      archive.on("error", fail);
      archive.on("end", () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      archive.on("entry", (entry: yauzl.Entry) => {
        active = (async () => {
          if (settled) return;
          entries += 1;
          declaredTotal += entry.uncompressedSize;
          if (
            entries > limits.maxEntries || !Number.isSafeInteger(entry.uncompressedSize) ||
            !Number.isSafeInteger(entry.compressedSize) || entry.uncompressedSize < 0 || entry.compressedSize < 0 ||
            entry.uncompressedSize > limits.maxEntryBytes || declaredTotal > limits.maxExtractBytes ||
            (entry.uncompressedSize > 0 && entry.uncompressedSize / Math.max(entry.compressedSize, 1) > limits.maxCompressionRatio)
          ) throw new GISProcessingError("ARCHIVE_LIMIT");
          const validated = safeEntry(entry);
          if (seen.has(validated.canonical)) throw new GISProcessingError("UNSAFE_ARCHIVE");
          seen.add(validated.canonical);
          // Normalize case and Unicode consistently so GDAL finds sidecars on Linux.
          const output = path.resolve(root, validated.canonical);
          if (!output.startsWith(`${root}${path.sep}`)) throw new GISProcessingError("UNSAFE_ARCHIVE");
          if (validated.directory) {
            await mkdir(output, { recursive: true, mode: 0o700 });
          } else {
            if (entry.uncompressedSize === 0) throw new GISProcessingError("INVALID_ARCHIVE");
            basenames.add(validated.basename);
            if (basenames.size > 1 || files.has(validated.extension)) throw new GISProcessingError("MULTIPLE_SHAPEFILES");
            files.set(validated.extension, output);
            await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
            const stream = await new Promise<import("node:stream").Readable>((resolveStream, rejectStream) => {
              archive.openReadStream(entry, (error, readable) => error ? rejectStream(error) : resolveStream(readable));
            });
            let size = 0;
            let checksum = 0;
            await pipeline(
              stream,
              new Transform({
                transform(chunk: Buffer, _encoding, callback) {
                  size += chunk.length;
                  actualTotal += chunk.length;
                  if (size > limits.maxEntryBytes || actualTotal > limits.maxExtractBytes || size / Math.max(entry.compressedSize, 1) > limits.maxCompressionRatio) {
                    callback(new GISProcessingError("ARCHIVE_LIMIT"));
                    return;
                  }
                  checksum = crc32(chunk, checksum);
                  callback(null, chunk);
                },
                flush(callback) {
                  callback(size !== entry.uncompressedSize || checksum !== entry.crc32 ? new GISProcessingError("INVALID_ARCHIVE") : undefined);
                },
              }),
              // Exclusive creation also refuses existing symlinks.
              createWriteStream(output, { flags: "wx", mode: 0o600 }),
              { signal: abort.signal },
            );
          }
          if (!settled) archive.readEntry();
        })();
        active.catch(fail);
      });
      archive.readEntry();
    });
    for (const extension of [".shp", ".shx", ".dbf", ".prj"]) {
      if (!files.has(extension)) throw new GISProcessingError(`MISSING_${extension.slice(1).toUpperCase()}`);
    }
    succeeded = true;
    return { shpPath: files.get(".shp")!, prjPath: files.get(".prj")!, ...(files.has(".cpg") ? { cpgPath: files.get(".cpg")! } : {}) };
  } catch (error) {
    throw error instanceof GISProcessingError ? error : new GISProcessingError("INVALID_ARCHIVE");
  } finally {
    if (timer) clearTimeout(timer);
    abort.abort();
    zip?.close();
    await active.catch(() => undefined);
    if (created && !succeeded) await rm(root, { recursive: true, force: true });
  }
}
