import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gisLimits } from "./config";
import { GISProcessingError } from "./errors";

export type VectorGeometry =
  | "Point"
  | "MultiPoint"
  | "LineString"
  | "MultiLineString"
  | "Polygon"
  | "MultiPolygon";
export interface ShapefileMetadata {
  featureCount: number;
  sourceSrid: number | null;
  sourceCrsWkt: string;
  geometryType: VectorGeometry;
  disabledDrivers: string[];
}
const geometryTypes = new Set<string>([
  "Point",
  "MultiPoint",
  "LineString",
  "MultiLineString",
  "Polygon",
  "MultiPolygon",
]);

// Never inherit web credentials, LD_PRELOAD, driver plugins, or network-enabled GDAL settings.
function processEnvironment(
  extra: Partial<NodeJS.ProcessEnv> = {},
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PROJ_NETWORK: "OFF",
    GDAL_DISABLE_READDIR_ON_OPEN: "EMPTY_DIR",
    GDAL_DRIVER_PATH: "disable",
    CPL_VSIL_CURL_ALLOWED_EXTENSIONS: "",
    ...extra,
  };
}

async function runGdal(
  command: "/usr/bin/python3" | "ogr2ogr",
  args: string[],
  env: Partial<NodeJS.ProcessEnv> = {},
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new GISProcessingError("STALE_JOB");
  return new Promise((done, reject) => {
    const child = spawn(command, args, {
      shell: false,
      env: processEnvironment(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let outputSize = 0;
    let errorSize = 0;
    let failure: string | undefined;
    const terminate = (code: string) => {
      failure = code;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(
      () => terminate("PROCESS_TIMEOUT"),
      gisLimits().processTimeoutMs,
    );
    const abort = () => terminate("STALE_JOB");
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > 2 * 1024 * 1024) terminate("GDAL_FAILED");
      else output.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorSize += chunk.length;
      if (errorSize > 256 * 1024) terminate("GDAL_FAILED");
      else errors.push(chunk);
    });
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    child.once("error", () => {
      cleanup();
      reject(new GISProcessingError("GDAL_UNAVAILABLE"));
    });
    child.once("close", (code) => {
      cleanup();
      if (failure || code !== 0)
        return reject(new GISProcessingError(failure || "GDAL_FAILED"));
      // Successful imports must not silently truncate values or replace undecodable characters.
      if (
        /truncat|cannot.*(?:recode|convert)|invalid.*(?:UTF|encoding)|failed.*(?:recode|convert)/i.test(
          Buffer.concat(errors).toString("utf8"),
        )
      ) {
        return reject(new GISProcessingError("GDAL_FAILED"));
      }
      done(Buffer.concat(output).toString("utf8"));
    });
  });
}

export async function inspectShapefile(
  shpPath: string,
  prjPath: string,
  signal?: AbortSignal,
): Promise<ShapefileMetadata> {
  const prj = await readFile(prjPath, "utf8").catch(() => "");
  if (!prj.trim() || prj.length > 128 * 1024)
    throw new GISProcessingError("UNKNOWN_CRS");
  const raw = await runGdal(
    "/usr/bin/python3",
    [fileURLToPath(new URL("./inspect-shapefile.py", import.meta.url)), shpPath],
    {},
    signal,
  );
  let info: {
    driverShortName?: string;
    disabledDrivers?: string[];
    layers?: Array<{
      featureCount?: number;
      geometryFields?: Array<{
        type?: string;
        coordinateSystem?: {
          wkt?: string;
          projjson?: { id?: { authority?: string; code?: number } };
        };
      }>;
    }>;
  };
  try {
    info = JSON.parse(raw);
  } catch {
    throw new GISProcessingError("GDAL_FAILED");
  }
  if (info.driverShortName !== "ESRI Shapefile" || info.layers?.length !== 1)
    throw new GISProcessingError("GDAL_FAILED");
  if (!Array.isArray(info.disabledDrivers) || info.disabledDrivers.length > 1000 ||
    info.disabledDrivers.some((name) => typeof name !== "string" || !/^[\w .()+-]{1,100}$/.test(name) || ["ESRI Shapefile", "PostgreSQL"].includes(name)))
    throw new GISProcessingError("GDAL_FAILED");
  const layer = info.layers[0];
  const geometry = layer.geometryFields?.[0];
  if (layer.geometryFields?.length !== 1 || !geometry)
    throw new GISProcessingError("UNSUPPORTED_GEOMETRY");
  const geometryType = geometry.type
    ?.replace(/^(?:3D |Measured )+/g, "")
    .replace(/ ZM?$/, "");
  if (!geometryType || !geometryTypes.has(geometryType))
    throw new GISProcessingError("UNSUPPORTED_GEOMETRY");
  const wkt = geometry.coordinateSystem?.wkt;
  if (!wkt || !/^(?:GEOGCRS|PROJCRS|GEOGCS|PROJCS)\[/.test(wkt))
    throw new GISProcessingError("UNKNOWN_CRS");
  const featureCount = layer.featureCount;
  if (!Number.isSafeInteger(featureCount) || featureCount! < 1)
    throw new GISProcessingError("EMPTY_DATASET");
  if (featureCount! > gisLimits().maxFeatures)
    throw new GISProcessingError("FEATURE_LIMIT");
  const identifier = geometry.coordinateSystem?.projjson?.id;
  const sourceSrid =
    identifier?.authority === "EPSG" &&
    Number.isSafeInteger(identifier.code) &&
    identifier.code! > 0
      ? identifier.code!
      : null;
  return {
    featureCount: featureCount!,
    sourceSrid,
    sourceCrsWkt: wkt,
    geometryType: geometryType as VectorGeometry,
    disabledDrivers: info.disabledDrivers,
  };
}

function credentialValue(value: string) {
  if (/[\r\n\0]/.test(value)) throw new GISProcessingError("GDAL_UNAVAILABLE");
  return value;
}
function passValue(value: string) {
  return credentialValue(value).replaceAll("\\", "\\\\").replaceAll(":", "\\:");
}

/** libpq receives credentials in mode-0600 files, never argv, stderr, or job metadata. */
export async function importShapefile(input: {
  shpPath: string;
  stageName: string;
  connectionString: string;
  workDirectory: string;
  disabledDrivers: string[];
  signal?: AbortSignal;
}) {
  if (!/^stage_[0-9a-f]{32}$/.test(input.stageName))
    throw new GISProcessingError("GDAL_UNAVAILABLE");
  let url: URL;
  try {
    url = new URL(input.connectionString);
  } catch {
    throw new GISProcessingError("GDAL_UNAVAILABLE");
  }
  if (!/^postgres(?:ql)?:$/.test(url.protocol))
    throw new GISProcessingError("GDAL_UNAVAILABLE");
  const host = credentialValue(url.hostname.replace(/^\[|\]$/g, ""));
  const port = url.port || "5432";
  const database = credentialValue(decodeURIComponent(url.pathname.slice(1)));
  const user = credentialValue(decodeURIComponent(url.username));
  const password = decodeURIComponent(url.password);
  const sslmode = url.searchParams.get("sslmode") || "prefer";
  if (
    !host ||
    !database ||
    !user ||
    ![
      "disable",
      "allow",
      "prefer",
      "require",
      "verify-ca",
      "verify-full",
    ].includes(sslmode)
  )
    throw new GISProcessingError("GDAL_UNAVAILABLE");
  const secretDirectory = join(input.workDirectory, "credentials");
  await mkdir(secretDirectory, { mode: 0o700 });
  const servicePath = join(secretDirectory, "pg_service.conf");
  const passwordPath = join(secretDirectory, "pgpass");
  const geometryColumn = `geom_${input.stageName.slice(6)}`;
  const fidColumn = `fid_${input.stageName.slice(6)}`;
  try {
    await writeFile(
      servicePath,
      `[portal_worker]\nhost=${host}\nport=${port}\ndbname=${database}\nuser=${user}\nsslmode=${sslmode}\nconnect_timeout=10\n`,
      { mode: 0o600, flag: "wx" },
    );
    await writeFile(
      passwordPath,
      `${[host, port, database, user, password].map(passValue).join(":")}\n`,
      { mode: 0o600, flag: "wx" },
    );
    await runGdal(
      "ogr2ogr",
      [
        "-f",
        "PostgreSQL",
        "PG:service=portal_worker",
        input.shpPath,
        "-nln",
        input.stageName,
        "-lco",
        "SCHEMA=gis_staging",
        "-lco",
        `GEOMETRY_NAME=${geometryColumn}`,
        "-lco",
        `FID=${fidColumn}`,
        "-lco",
        "LAUNDER=NO",
        "-lco",
        "SPATIAL_INDEX=NONE",
        "-lco",
        "PRECISION=NO",
        "-t_srs",
        "EPSG:4326",
        "-nlt",
        "GEOMETRY",
        "-unsetFid",
        "-gt",
        "65536",
      ],
      { PGSERVICEFILE: servicePath, PGPASSFILE: passwordPath, GDAL_SKIP: input.disabledDrivers.join(",") },
      input.signal,
    );
    return { geometryColumn, fidColumn };
  } finally {
    await rm(secretDirectory, { recursive: true, force: true });
  }
}
