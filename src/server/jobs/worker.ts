import { randomUUID } from "node:crypto";
import { lstat, mkdir, opendir, rm, rmdir } from "node:fs/promises";
import { dirname, join, parse, sep } from "node:path";
import type { Pool, PoolClient } from "pg";
import { extractShapefile } from "../processing/archive";
import { gisLimits } from "../processing/config";
import { GISProcessingError, publicGisError } from "../processing/errors";
import {
  importShapefile,
  inspectShapefile,
  type ShapefileMetadata,
} from "../processing/gdal";
import { cleanupUpload, uploadDirectory } from "../storage/local";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const leaseSeconds = 90;
const maxAttempts = 3;
interface Job {
  id: string;
  layer_id: string | null;
  actor_id: string;
  kind: "IMPORT_VECTOR" | "DELETE_LAYER";
  locked_by: string;
  attempts: number;
  payload: { uploadId?: string };
}
interface Layer {
  id: string;
  name: string;
  state: string;
  source_type: string;
  layer_type: string;
  table_name: string;
  storage_metadata: { managedBy?: string; uploadId?: string };
}
const identifier = (value: string) => {
  if (!/^(?:layer_|stage_|geom_|fid_)[0-9a-f]{32}$/.test(value))
    throw new GISProcessingError("NOT_MANAGED");
  return `"${value}"`;
};
const stageName = (token: string) => {
  if (!UUID.test(token)) throw new GISProcessingError("STALE_JOB");
  return `stage_${token.replaceAll("-", "")}`;
};
function workDirectory(job: Pick<Job, "id" | "locked_by">) {
  if (!UUID.test(job.id) || !UUID.test(job.locked_by))
    throw new GISProcessingError("STALE_JOB");
  // Reuse storage's root validation (in particular, no public directory).
  return join(dirname(uploadDirectory(job.id)), "tmp", job.id, job.locked_by);
}

/** Check every ancestor before reading/writing/removing private artifacts. */
async function checkedDirectory(directory: string, create = false) {
  const root = parse(directory).root;
  let current = root;
  for (const component of directory.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    if (create) {
      await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new GISProcessingError("STORAGE_ERROR");
  }
}

async function removeAttempt(job: Pick<Job, "id" | "locked_by">) {
  const directory = workDirectory(job);
  try {
    await checkedDirectory(directory);
    await rm(directory, { recursive: true, force: true });
    // Keep the shared job parent: a replacement claim may be about to mkdir
    // its own attempt. The age-gated reconciler removes idle empty parents.
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function oldDirectory(directory: string, before: number) {
  try {
    const info = await lstat(directory);
    return info.isDirectory() && !info.isSymbolicLink() && info.mtimeMs < before;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Inventory disk, not just the newest finished jobs: this also finds uploads
 * abandoned before enqueue and artifacts whose job history has been pruned.
 */
async function reconcileArtifacts(pool: Pool) {
  const root = dirname(uploadDirectory(randomUUID()));
  try {
    await checkedDirectory(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  // A receiver and both bounded GDAL steps have time to finish before expiry.
  const minimumAge = Math.max(15 * 60_000, 2 * gisLimits().processTimeoutMs + leaseSeconds * 1000);
  const before = Date.now() - minimumAge;
  for await (const entry of await opendir(root)) {
    if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
    const directory = uploadDirectory(entry.name);
    if (!(await oldDirectory(directory, before))) continue;
    await transaction(pool, async (client) => {
      // Serializes the last check/removal with metadata + job creation.
      await client.query("SELECT pg_advisory_xact_lock(73429102)");
      const active = await client.query(
        "SELECT 1 FROM app.gis_jobs WHERE status IN ('QUEUED','RUNNING') AND payload->>'uploadId'=$1 LIMIT 1",
        [entry.name],
      );
      if (!active.rowCount && await oldDirectory(directory, before))
        await cleanupUpload(entry.name);
    });
  }

  const temporary = join(root, "tmp");
  try {
    await checkedDirectory(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for await (const jobEntry of await opendir(temporary)) {
    if (!jobEntry.isDirectory() || !UUID.test(jobEntry.name)) continue;
    const jobDirectory = join(temporary, jobEntry.name);
    await checkedDirectory(jobDirectory);
    for await (const attempt of await opendir(jobDirectory)) {
      if (!attempt.isDirectory() || !UUID.test(attempt.name)) continue;
      const directory = join(jobDirectory, attempt.name);
      if (!(await oldDirectory(directory, before))) continue;
      await transaction(pool, async (client) => {
        // A claim token is unique and can never be reused by the next worker.
        const live = await client.query(
          "SELECT 1 FROM app.gis_jobs WHERE id=$1 AND locked_by=$2 AND status='RUNNING' FOR UPDATE",
          [jobEntry.name, attempt.name],
        );
        if (!live.rowCount && await oldDirectory(directory, before))
          await removeAttempt({ id: jobEntry.name, locked_by: attempt.name });
      });
    }
    // Empty job parents can remain when a process died immediately after mkdir.
    if (await oldDirectory(jobDirectory, before)) {
      const active = await pool.query(
        "SELECT 1 FROM app.gis_jobs WHERE id=$1 AND status IN ('QUEUED','RUNNING')",
        [jobEntry.name],
      );
      if (!active.rowCount) await rmdir(jobDirectory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
      });
    }
  }
}

async function transaction<T>(
  pool: Pool,
  action: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function checkActor(client: Pool | PoolClient, actorId: string) {
  const result = await client.query(
    `SELECT 1 FROM app.users u WHERE u.id=$1 AND u.status='APPROVED' AND u.role='ADMIN'
    AND u.google_id IS NOT NULL AND u.email_verified IS NOT NULL
    AND EXISTS (SELECT 1 FROM app.accounts a WHERE a.user_id=u.id AND a.provider='google' AND a.provider_account_id=u.google_id)`,
    [actorId],
  );
  if (!result.rowCount) throw new GISProcessingError("FORBIDDEN");
}
async function checkedLayer(
  client: Pool | PoolClient,
  job: Job,
  lock = false,
): Promise<Layer> {
  const result = await client.query<Layer>(
    `SELECT id,name,state,source_type,layer_type,table_name,storage_metadata FROM app.layers WHERE id=$1 ${lock ? "FOR UPDATE" : ""}`,
    [job.layer_id],
  );
  const layer = result.rows[0];
  if (!layer) throw new GISProcessingError("NOT_FOUND");
  if (
    layer.source_type !== "SHP" ||
    layer.layer_type !== "VECTOR" ||
    layer.table_name !== `layer_${layer.id.replaceAll("-", "")}` ||
    layer.storage_metadata.managedBy !== "portal-shapefile-v1"
  )
    throw new GISProcessingError("NOT_MANAGED");
  if (
    layer.state !== (job.kind === "IMPORT_VECTOR" ? "PROCESSING" : "DELETING")
  )
    throw new GISProcessingError("LAYER_BUSY");
  return layer;
}
async function checkLease(client: PoolClient, job: Job) {
  const result = await client.query(
    "SELECT 1 FROM app.gis_jobs WHERE id=$1 AND locked_by=$2 AND status='RUNNING' AND lease_until > clock_timestamp() FOR UPDATE",
    [job.id, job.locked_by],
  );
  if (!result.rowCount) throw new GISProcessingError("STALE_JOB");
}
async function finishJob(client: PoolClient, job: Job) {
  const result = await client.query(
    "UPDATE app.gis_jobs SET status='SUCCEEDED',error_code=NULL,lease_until=NULL,locked_by=NULL,updated_at=now() WHERE id=$1 AND locked_by=$2 AND status='RUNNING' AND lease_until > clock_timestamp()",
    [job.id, job.locked_by],
  );
  if (!result.rowCount) throw new GISProcessingError("STALE_JOB");
}

async function dropStage(pool: Pool, token: string) {
  await transaction(pool, async (client) => {
    await client.query("SET LOCAL lock_timeout = '1s'");
    await client.query(
      `DROP TABLE IF EXISTS gis_staging.${identifier(stageName(token))}`,
    );
  });
}

async function publishImport(
  pool: Pool,
  job: Job,
  metadata: ShapefileMetadata,
  columns: { geometryColumn: string; fidColumn: string },
) {
  const staging = `gis_staging.${identifier(stageName(job.locked_by))}`;
  const geom = identifier(columns.geometryColumn);
  const stats = await pool.query<{
    total: string;
    invalid: string;
    types: string[];
  }>(`SELECT count(*)::text AS total,
    count(*) FILTER (WHERE ${geom} IS NULL OR ST_IsEmpty(${geom}) OR NOT ST_IsValid(${geom}) OR ST_SRID(${geom})<>4326
    OR ST_XMin(${geom}::box3d)<-180 OR ST_XMax(${geom}::box3d)>180 OR ST_YMin(${geom}::box3d)<-90 OR ST_YMax(${geom}::box3d)>90)::text AS invalid,
    array_agg(DISTINCT GeometryType(${geom})) AS types FROM ${staging}`);
  const result = stats.rows[0];
  if (
    Number(result.total) !== metadata.featureCount ||
    Number(result.total) < 1 ||
    Number(result.invalid) > 0
  )
    throw new GISProcessingError("INVALID_GEOMETRY");
  const typeNames: Record<string, string> = {
    POINT: "Point",
    MULTIPOINT: "MultiPoint",
    LINESTRING: "LineString",
    MULTILINESTRING: "MultiLineString",
    POLYGON: "Polygon",
    MULTIPOLYGON: "MultiPolygon",
  };
  const types = result.types.map((type) => typeNames[type]);
  if (
    types.some((type) => !type) ||
    new Set(types.map((type) => type.replace("Multi", ""))).size !== 1
  )
    throw new GISProcessingError("UNSUPPORTED_GEOMETRY");
  const geometryType =
    types.find((type) => type.startsWith("Multi")) || types[0];
  await transaction(pool, async (client) => {
    // Same lock as bootstrap/user administration prevents demotion/rejection racing publication.
    await client.query("SELECT pg_advisory_xact_lock(73429101)");
    await checkLease(client, job);
    await checkActor(client, job.actor_id);
    const layer = await checkedLayer(client, job, true);
    const table = `gis.${identifier(layer.table_name)}`;
    await client.query(
      `CREATE TABLE ${table} AS SELECT ${identifier(columns.fidColumn)}::bigint AS feature_id,
      to_jsonb(source) - $1::text - $2::text AS properties, ${geom} AS geom FROM ${staging} source`,
      [columns.geometryColumn, columns.fidColumn],
    );
    await client.query(
      `ALTER TABLE ${table} ALTER COLUMN feature_id SET NOT NULL, ALTER COLUMN properties SET NOT NULL, ALTER COLUMN geom SET NOT NULL, ADD PRIMARY KEY(feature_id)`,
    );
    await client.query(`CREATE INDEX ON ${table} USING gist(geom)`);
    await client.query(`GRANT SELECT ON ${table} TO gis_app`);
    await client.query(`ANALYZE ${table}`);
    await client.query(
      `UPDATE app.layers SET state='READY', srid=4326, source_srid=$2,source_crs_wkt=$3,geometry_type=$4,feature_count=$5,
      bbox=(SELECT ST_SetSRID(ST_Extent(geom)::geometry,4326) FROM ${table}),
      style_json=$6::jsonb,storage_metadata=storage_metadata || '{"sourceRetained":false}'::jsonb,updated_at=now() WHERE id=$1`,
      [
        layer.id,
        metadata.sourceSrid,
        metadata.sourceCrsWkt,
        geometryType,
        metadata.featureCount,
        JSON.stringify({
          color: "#087f8c",
          opacity: 0.65,
          width: 2,
          radius: 6,
        }),
      ],
    );
    await client.query(
      "INSERT INTO app.audit_logs(user_id,action,target_type,target_id,metadata) VALUES ($1,'LAYER_UPLOADED','layer',$2,$3::jsonb)",
      [
        job.actor_id,
        layer.id,
        JSON.stringify({
          jobId: job.id,
          featureCount: metadata.featureCount,
          geometryType,
        }),
      ],
    );
    await finishJob(client, job);
    await client.query(`DROP TABLE ${staging}`);
  });
}

async function deleteLayer(pool: Pool, job: Job) {
  // Cleanup was authorized when enqueued. Revoking the actor later must not strand a hidden layer.
  await transaction(pool, async (client) => {
    await checkLease(client, job);
    const layer = await checkedLayer(client, job, true);
    await client.query(
      `DROP TABLE IF EXISTS gis.${identifier(layer.table_name)}`,
    );
    await client.query(
      "INSERT INTO app.audit_logs(user_id,action,target_type,target_id,metadata) VALUES ($1,'LAYER_DELETED','layer',$2,$3::jsonb)",
      [
        job.actor_id,
        layer.id,
        JSON.stringify({ jobId: job.id, name: layer.name }),
      ],
    );
    await finishJob(client, job);
    await client.query("DELETE FROM app.layers WHERE id=$1", [layer.id]);
  });
}

function failureCode(error: unknown) {
  if (error instanceof GISProcessingError) return error.code;
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  return /^(?:08\w{3}|53\w{3}|57P0[123]|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|40001|40P01|55P03)$/.test(
    code,
  )
    ? "DATABASE_UNAVAILABLE"
    : "IMPORT_FAILED";
}
async function failJob(pool: Pool, job: Job, error: unknown) {
  const code = failureCode(error);
  const retry = code === "DATABASE_UNAVAILABLE" && job.attempts < maxAttempts;
  return transaction(pool, async (client) => {
    const result = await client.query(
      `UPDATE app.gis_jobs SET status=$3,error_code=$4,lease_until=NULL,locked_by=NULL,
      available_at=now()+interval '10 seconds',updated_at=now() WHERE id=$1 AND locked_by=$2 AND status='RUNNING' AND lease_until>clock_timestamp() RETURNING layer_id`,
      [
        job.id,
        job.locked_by,
        retry ? "QUEUED" : "FAILED",
        publicGisError(code).code,
      ],
    );
    if (result.rowCount && !retry && job.kind === "IMPORT_VECTOR") {
      await client.query(
        "UPDATE app.layers SET state='FAILED',storage_metadata=storage_metadata || jsonb_build_object('errorCode',$2::text),updated_at=now() WHERE id=$1 AND state='PROCESSING'",
        [job.layer_id, publicGisError(code).code],
      );
    }
    return Boolean(result.rowCount && !retry);
  });
}

/** Claims at most one job. Multiple worker processes are safe; each process runs one job at a time. */
export async function runNextJob(pool: Pool): Promise<boolean> {
  const token = randomUUID();
  const claimed = await pool.query<Job>(
    `WITH candidate AS (SELECT id FROM app.gis_jobs WHERE status='QUEUED' AND available_at<=now() AND attempts<$2 ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
    UPDATE app.gis_jobs j SET status='RUNNING',attempts=j.attempts+1,locked_by=$1,lease_until=now()+make_interval(secs=>$3),updated_at=now() FROM candidate WHERE j.id=candidate.id RETURNING j.*`,
    [token, maxAttempts, leaseSeconds],
  );
  const job = claimed.rows[0];
  if (!job) return false;
  const controller = new AbortController();
  let renewing = false;
  const heartbeat = setInterval(async () => {
    if (renewing) return;
    renewing = true;
    try {
      const response = await pool.query(
        "UPDATE app.gis_jobs SET lease_until=now()+make_interval(secs=>$3),updated_at=now() WHERE id=$1 AND locked_by=$2 AND status='RUNNING' AND lease_until>clock_timestamp()",
        [job.id, token, leaseSeconds],
      );
      if (!response.rowCount) controller.abort();
    } catch {
      controller.abort();
    } finally {
      renewing = false;
    }
  }, 20_000);
  heartbeat.unref();
  let terminal = false;
  try {
    const layer = await checkedLayer(pool, job);
    if (job.kind === "DELETE_LAYER") {
      await deleteLayer(pool, job);
    } else {
      await checkActor(pool, job.actor_id);
      const uploadId = job.payload.uploadId;
      if (
        !uploadId ||
        !UUID.test(uploadId) ||
        layer.storage_metadata.uploadId !== uploadId
      )
        throw new GISProcessingError("INVALID_UPLOAD");
      const directory = workDirectory(job);
      await checkedDirectory(dirname(directory), true);
      // Claim directories are fresh; do not accept a pre-existing path.
      await mkdir(directory, { mode: 0o700 });
      const extracted = await extractShapefile(
        join(uploadDirectory(uploadId), "archive.zip"),
        join(directory, "extract"),
      );
      const metadata = await inspectShapefile(
        extracted.shpPath,
        extracted.prjPath,
        controller.signal,
      );
      const connectionString =
        pool.options.connectionString || process.env.GIS_WORKER_DATABASE_URL;
      if (!connectionString)
        throw new GISProcessingError("DATABASE_UNAVAILABLE");
      const columns = await importShapefile({
        shpPath: extracted.shpPath,
        stageName: stageName(token),
        connectionString,
        workDirectory: directory,
        disabledDrivers: metadata.disabledDrivers,
        signal: controller.signal,
      });
      await publishImport(pool, job, metadata, columns);
    }
    terminal = true;
  } catch (error) {
    terminal = await failJob(pool, job, error).catch(() => false);
  } finally {
    clearInterval(heartbeat);
    // A stale worker touches only its own staging table and attempt directory.
    await dropStage(pool, token).catch(() => undefined);
    await removeAttempt(job).catch(() => undefined);
    // Only this still-fenced terminal transition proves that no replacement
    // claim can start inside the same parent directory.
    if (terminal)
      await rmdir(dirname(workDirectory(job))).catch(() => undefined);
    if (terminal && job.payload.uploadId && UUID.test(job.payload.uploadId))
      await cleanupUpload(job.payload.uploadId).catch(() => undefined);
  }
  return true;
}

/** Recover a crashed worker without allowing its stale claim to publish. */
export async function recoverExpiredJobs(pool: Pool): Promise<void> {
  const expired = await transaction(pool, async (client) => {
    const result = await client.query<Job>(
      "SELECT * FROM app.gis_jobs WHERE status='RUNNING' AND lease_until<=clock_timestamp() ORDER BY lease_until FOR UPDATE SKIP LOCKED LIMIT 20",
    );
    for (const job of result.rows) {
      const exhausted = job.attempts >= maxAttempts;
      await client.query(
        "UPDATE app.gis_jobs SET status=$2,error_code='JOB_EXPIRED',locked_by=NULL,lease_until=NULL,available_at=now(),updated_at=now() WHERE id=$1",
        [job.id, exhausted ? "FAILED" : "QUEUED"],
      );
      if (exhausted && job.kind === "IMPORT_VECTOR")
        await client.query(
          "UPDATE app.layers SET state='FAILED',storage_metadata=storage_metadata || '{\"errorCode\":\"JOB_EXPIRED\"}'::jsonb,updated_at=now() WHERE id=$1 AND state='PROCESSING'",
          [job.layer_id],
        );
    }
    return result.rows;
  });
  for (const job of expired) {
    await dropStage(pool, job.locked_by).catch(() => undefined);
    await removeAttempt(job).catch(() => undefined);
    if (job.attempts >= maxAttempts) {
      await rmdir(dirname(workDirectory(job))).catch(() => undefined);
      if (job.payload.uploadId && UUID.test(job.payload.uploadId))
        await cleanupUpload(job.payload.uploadId).catch(() => undefined);
    }
  }
  // Reconcile partial DDL and source cleanup when a crash occurred between commit and filesystem cleanup.
  const orphanStages = await pool.query<{
    tablename: string;
  }>(`SELECT tablename FROM pg_tables WHERE schemaname='gis_staging' AND tablename ~ '^stage_[0-9a-f]{32}$'
    AND NOT EXISTS (SELECT 1 FROM app.gis_jobs WHERE status='RUNNING' AND replace(locked_by::text,'-','')=substring(tablename from 7)) LIMIT 20`);
  for (const row of orphanStages.rows) {
    await transaction(pool, async (client) => {
      await client.query("SET LOCAL lock_timeout='1s'");
      await client.query(
        `DROP TABLE IF EXISTS gis_staging.${identifier(row.tablename)}`,
      );
    }).catch(() => undefined);
  }
  await reconcileArtifacts(pool);
}
