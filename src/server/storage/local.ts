import { createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import busboy from "busboy";
import { gisLimits } from "@/server/processing/config";
import { GISProcessingError } from "@/server/processing/errors";

const uploadIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function storageRoot() {
  const root = path.resolve(gisLimits().storageRoot);
  const publicRoot = path.resolve(process.cwd(), "public");
  const publicRelative = path.relative(publicRoot, root);
  const workingRelative = path.relative(root, process.cwd());
  if (
    root === path.parse(root).root ||
    publicRelative === "" ||
    (!publicRelative.startsWith(`..${path.sep}`) && publicRelative !== "..") ||
    workingRelative === "" ||
    (!workingRelative.startsWith(`..${path.sep}`) && workingRelative !== "..")
  ) {
    throw new GISProcessingError("STORAGE_ERROR");
  }
  return root;
}

// Walk every component: recursive mkdir by itself would follow existing symlinks.
async function privateDirectory(directory: string, create: boolean) {
  const parsed = path.parse(directory);
  let current = parsed.root;
  for (const component of directory.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new GISProcessingError("STORAGE_ERROR");
      }
    } catch (error) {
      if (create && (error as NodeJS.ErrnoException).code === "ENOENT") {
        try {
          await mkdir(current, { mode: 0o700 });
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
        }
        const info = await lstat(current);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new GISProcessingError("STORAGE_ERROR");
      } else {
        throw error;
      }
    }
  }
}

export function uploadDirectory(id: string): string {
  if (!uploadIdPattern.test(id)) throw new GISProcessingError("INVALID_UPLOAD");
  return path.join(storageRoot(), id.toLowerCase());
}

export async function createUploadDirectory(id: string): Promise<string> {
  const directory = uploadDirectory(id);
  try {
    await privateDirectory(path.dirname(directory), true);
    await chmod(path.dirname(directory), 0o700);
    await mkdir(directory, { mode: 0o700 });
    return directory;
  } catch {
    throw new GISProcessingError("STORAGE_ERROR");
  }
}

export async function cleanupUpload(id: string): Promise<void> {
  const directory = uploadDirectory(id);
  try {
    await privateDirectory(path.dirname(directory), false);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new GISProcessingError("STORAGE_ERROR");
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new GISProcessingError("STORAGE_ERROR");
  }
}

/** Check under the queue lock so an old, reaped upload cannot be enqueued later. */
export async function assertUploadReady(id: string): Promise<void> {
  try {
    const directory = uploadDirectory(id);
    await privateDirectory(directory, false);
    const archive = await lstat(path.join(directory, "archive.zip"));
    if (!archive.isFile() || archive.isSymbolicLink() || archive.size < 22 || archive.size > gisLimits().maxUploadBytes) {
      throw new GISProcessingError("INVALID_UPLOAD");
    }
  } catch {
    throw new GISProcessingError("INVALID_UPLOAD");
  }
}

export async function receiveShapefileUpload(request: Request, id: string): Promise<{
  zipPath: string;
  fields: { name: string; description: string; isVisible: boolean };
}> {
  const limits = gisLimits();
  const maximumRequestBytes = limits.maxUploadBytes + 64 * 1024;
  const contentType = request.headers.get("content-type") ?? "";
  const contentLength = request.headers.get("content-length");
  if (!request.body || !/^multipart\/form-data(?:;|$)/i.test(contentType)) {
    throw new GISProcessingError("INVALID_UPLOAD");
  }
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) throw new GISProcessingError("INVALID_UPLOAD");
    if (Number(contentLength) > maximumRequestBytes) throw new GISProcessingError("UPLOAD_TOO_LARGE");
  }

  let parser: ReturnType<typeof busboy>;
  try {
    parser = busboy({
      headers: { "content-type": contentType },
      limits: { fileSize: limits.maxUploadBytes, files: 1, fields: 3, parts: 5, fieldNameSize: 64, fieldSize: 2000, headerPairs: 100 },
    });
  } catch {
    throw new GISProcessingError("INVALID_UPLOAD");
  }

  const directory = await createUploadDirectory(id);
  const zipPath = path.join(directory, "archive.zip");
  const abort = new AbortController();
  let failure: GISProcessingError | undefined;
  const fail = (code: string) => {
    failure ??= new GISProcessingError(code);
    abort.abort();
  };
  const onAbort = () => fail("INVALID_UPLOAD");
  request.signal.addEventListener("abort", onAbort, { once: true });
  if (request.signal.aborted) onAbort();
  const timer = setTimeout(() => fail("UPLOAD_TIMEOUT"), limits.processTimeoutMs);
  timer.unref();
  const fields = new Map<string, string>();
  const writes: Promise<void>[] = [];
  let files = 0;
  let requestBytes = 0;

  parser.on("field", (name, value, info) => {
    if (!["name", "description", "isVisible"].includes(name) || fields.has(name) || info.nameTruncated || info.valueTruncated) {
      fail("INVALID_METADATA");
      return;
    }
    fields.set(name, value);
  });
  parser.on("filesLimit", () => fail("INVALID_UPLOAD"));
  parser.on("fieldsLimit", () => fail("INVALID_METADATA"));
  parser.on("partsLimit", () => fail("INVALID_UPLOAD"));
  parser.on("file", (name, stream) => {
    files += 1;
    if (name !== "file" || files !== 1) {
      stream.resume();
      fail("INVALID_UPLOAD");
      return;
    }
    stream.on("limit", () => fail("UPLOAD_TOO_LARGE"));
    let bytes = 0;
    let signature = Buffer.alloc(0);
    const validate = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > limits.maxUploadBytes) {
          callback(new GISProcessingError("UPLOAD_TOO_LARGE"));
          return;
        }
        if (signature.length < 4) {
          signature = Buffer.concat([signature, chunk.subarray(0, 4 - signature.length)]);
          if (signature.length === 4 && !signature.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
            callback(new GISProcessingError("INVALID_ARCHIVE"));
            return;
          }
        }
        callback(null, chunk);
      },
      flush(callback) {
        callback(signature.length === 4 ? undefined : new GISProcessingError("INVALID_ARCHIVE"));
      },
    });
    writes.push(pipeline(
      stream,
      validate,
      // O_EXCL (wx) rejects existing files, including symlinks, in this private directory.
      createWriteStream(zipPath, { flags: "wx", mode: 0o600 }),
      { signal: abort.signal },
    ).catch((error: unknown) => {
      fail(error instanceof GISProcessingError ? error.code : abort.signal.aborted ? "INVALID_UPLOAD" : "STORAGE_ERROR");
    }));
  });

  try {
    await pipeline(
      Readable.fromWeb(request.body as ReadableStream<Uint8Array>),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          requestBytes += chunk.length;
          if (requestBytes > maximumRequestBytes) {
            fail("UPLOAD_TOO_LARGE");
            callback(failure);
          } else callback(null, chunk);
        },
      }),
      parser,
      { signal: abort.signal },
    );
    await Promise.all(writes);
    if (failure) throw failure;
    if (files !== 1) throw new GISProcessingError("INVALID_UPLOAD");
    const name = fields.get("name")?.trim() ?? "";
    const description = fields.get("description")?.trim() ?? "";
    const visible = fields.get("isVisible") ?? "true";
    if (!name || name.length > 200 || description.length > 2000 || /[\u0000-\u001f\u007f]/.test(name) || !["true", "false"].includes(visible)) {
      throw new GISProcessingError("INVALID_METADATA");
    }
    return { zipPath, fields: { name, description, isVisible: visible === "true" } };
  } catch (error) {
    abort.abort();
    await Promise.all(writes);
    await cleanupUpload(id);
    if (failure) throw failure;
    throw error instanceof GISProcessingError ? error : new GISProcessingError("INVALID_UPLOAD");
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", onAbort);
  }
}
