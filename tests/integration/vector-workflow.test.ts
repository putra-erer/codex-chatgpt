import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createShapefileFixture, type ShapeFixtureOptions } from "../helpers/shapefile-fixture.js";

type Actor = { id: string; token: string };
type Job = { id: string; status: string; layerId: string | null; error: { code: string; message: string } | null };
let owner: Pool;
let worker: Pool;
let runNextJob: (pool: Pool) => Promise<boolean>;
let recoverExpiredJobs: (pool: Pool) => Promise<void>;
let server: ChildProcess;
let baseUrl: string;
let directory: string;
let storage: string;
let admin: Actor;
let viewer: Actor;
let pending: Actor;
let rejected: Actor;
let csrfToken: string;
const actorIds: string[] = [];
const layerIds: string[] = [];
const originalStorage = process.env.GIS_STORAGE_ROOT;

async function actor(status = "APPROVED", role = "ADMIN"): Promise<Actor> {
  const id = randomUUID(), token = randomBytes(32).toString("hex"), subject = `vector-${id}`;
  await owner.query(`INSERT INTO app.users(id,email,name,google_id,email_verified,status,role,approved_at)
    VALUES($1,$2,'Vector workflow fixture',$3,now(),$4::app.user_status,$5,CASE WHEN $4::app.user_status='APPROVED' THEN now() ELSE NULL END)`,
  [id, `${id}@vector.example.test`, subject, status, role]);
  actorIds.push(id);
  await owner.query("INSERT INTO app.accounts(user_id,type,provider,provider_account_id) VALUES($1,'oidc','google',$2)", [id, subject]);
  await owner.query("INSERT INTO app.sessions(session_token,user_id,expires) VALUES($1,$2,now()+interval '1 hour')", [token, id]);
  return { id, token };
}

function request(path: string, user?: Actor | null, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (user) headers.set("cookie", `authjs.session-token=${user.token}`);
  return fetch(`${baseUrl}${path}`, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(15_000) });
}

function mutationHeaders(token = csrfToken, origin = baseUrl) {
  return { origin, "x-gis-csrf": token };
}

async function upload(path: string, name: string, user: Actor | null = admin, headers = mutationHeaders()) {
  const form = new FormData();
  form.set("name", name);
  form.set("description", "Isolated automated test upload");
  form.set("isVisible", "true");
  form.set("file", new Blob([new Uint8Array(await readFile(path))], { type: "application/zip" }), "untrusted-name.zip");
  return request("/api/admin/uploads", user, { method: "POST", headers, body: form });
}

async function queueUpload(options: ShapeFixtureOptions = {}, name = `Import ${randomUUID()}`) {
  const path = await createShapefileFixture(directory, options);
  const response = await upload(path, name);
  expect(response.status).toBe(202);
  const accepted = await response.json() as { jobId: string; layerId: string };
  layerIds.push(accepted.layerId);
  expect(accepted.jobId).toMatch(/^[a-f0-9-]{36}$/);
  return accepted;
}

async function processUpload(options: ShapeFixtureOptions = {}, name = `Import ${randomUUID()}`) {
  const accepted = await queueUpload(options, name);
  expect(await runNextJob(worker)).toBe(true);
  const jobResponse = await request(`/api/admin/jobs/${accepted.jobId}`, admin);
  expect(jobResponse.status).toBe(200);
  const job = await jobResponse.json() as Job;
  return { ...accepted, job };
}

async function patch(id: string, values: unknown, user: Actor | null = admin, headers = mutationHeaders()) {
  return request(`/api/admin/layers/${id}`, user, { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(values) });
}

beforeAll(async () => {
  const database = process.env.PORTAL_INTEGRATION_DATABASE;
  if (!database || !/^portal_test_[a-f0-9]{32}$/.test(database)) throw new Error("Use npm run test:integration to create an isolated database.");
  owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
  expect((await owner.query("SELECT current_database() AS name")).rows[0].name).toBe(database);
  if (!process.env.GIS_WORKER_DATABASE_URL) throw new Error("The integration runner must configure GIS_WORKER_DATABASE_URL.");
  const workerUrl = new URL(process.env.GIS_WORKER_DATABASE_URL);
  expect(workerUrl.pathname).toBe(`/${database}`);
  expect(decodeURIComponent(workerUrl.username)).toBe("gis_worker");
  worker = new Pool({ connectionString: workerUrl.toString() });
  directory = await mkdtemp(join(tmpdir(), "portal-vector-integration-"));
  storage = join(directory, "private-storage");
  process.env.GIS_STORAGE_ROOT = storage;
  ({ runNextJob, recoverExpiredJobs } = await import("@/server/jobs/worker"));
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Cannot allocate test server port.");
  const port = address.port;
  await new Promise<void>((done, reject) => listener.close((error) => error ? reject(error) : done()));
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [resolve(".next/standalone/server.js")], {
    env: { ...process.env, NODE_ENV: "production", HOSTNAME: "127.0.0.1", PORT: String(port), AUTH_URL: baseUrl, AUTH_SECRET: randomBytes(32).toString("hex"), GOOGLE_CLIENT_ID: "vector-integration", GOOGLE_CLIENT_SECRET: "vector-integration", SUPER_ADMIN_EMAILS: "", GIS_STORAGE_ROOT: storage },
    stdio: "ignore",
  });
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (server.exitCode !== null) throw new Error("Vector integration HTTP server exited.");
    try { ready = (await request("/login")).status === 200; } catch {}
    if (ready) break;
    await delay(100);
  }
  expect(ready).toBe(true);
  admin = await actor();
  viewer = await actor("APPROVED", "VIEWER");
  pending = await actor("PENDING", "ADMIN");
  rejected = await actor("REJECTED", "ADMIN");
  const response = await request("/api/admin/uploads", admin);
  expect(response.status).toBe(200);
  const configuration = await response.json();
  expect(configuration.limits.maxUploadBytes).toBeGreaterThan(0);
  csrfToken = configuration.csrfToken;
  expect(typeof csrfToken).toBe("string");
}, 40_000);

afterAll(async () => {
  if (server && server.exitCode === null) {
    const ended = once(server, "exit");
    server.kill("SIGTERM");
    const timeout = setTimeout(() => server.kill("SIGKILL"), 5000);
    await ended;
    clearTimeout(timeout);
  }
  await worker?.end();
  if (owner) {
    // Only fixture-owned rows/tables inside the runner's verified temporary DB.
    for (const id of layerIds) {
      const table = `layer_${id.replaceAll("-", "")}`;
      if (!/^layer_[a-f0-9]{32}$/.test(table)) throw new Error("Unsafe fixture table name.");
      await owner.query("DELETE FROM app.gis_jobs WHERE layer_id=$1", [id]);
      await owner.query("DELETE FROM app.layers WHERE id=$1", [id]);
      await owner.query(`DROP TABLE IF EXISTS gis.${table}`);
    }
    if (actorIds.length) {
      await owner.query("DELETE FROM app.gis_jobs WHERE actor_id=ANY($1::uuid[])", [actorIds]);
      await owner.query("DELETE FROM app.audit_logs WHERE user_id=ANY($1::uuid[]) OR target_id=ANY($2::text[])", [actorIds, layerIds]);
      await owner.query("DELETE FROM app.users WHERE id=ANY($1::uuid[])", [actorIds]);
    }
    await owner.end();
  }
  if (directory) await rm(directory, { recursive: true, force: true });
  if (originalStorage === undefined) delete process.env.GIS_STORAGE_ROOT;
  else process.env.GIS_STORAGE_ROOT = originalStorage;
});

describe("real shapefile HTTP and restricted worker workflow", () => {
  it("enforces live approval/admin status and CSRF on every privileged endpoint", async () => {
    const path = await createShapefileFixture(directory);
    const id = randomUUID();
    for (const user of [undefined, viewer, pending, rejected]) {
      const status = user ? 403 : 401;
      for (const endpoint of ["/api/admin/uploads", "/api/admin/layers", `/api/admin/jobs/${id}`]) expect((await request(endpoint, user)).status).toBe(status);
      expect((await upload(path, "Forbidden upload", user ?? null)).status).toBe(status);
      expect((await patch(id, { name: "Forged", description: "", isVisible: true }, user ?? null)).status).toBe(status);
      expect((await request(`/api/admin/layers/${id}`, user, { method: "DELETE", headers: mutationHeaders() })).status).toBe(status);
    }
    for (const headers of [mutationHeaders(""), mutationHeaders("invalid"), mutationHeaders(csrfToken, "https://foreign.example")]) {
      expect((await upload(path, "Invalid CSRF", admin, headers)).status).toBe(403);
      expect((await patch(id, { name: "Forged", description: "", isVisible: true }, admin, headers)).status).toBe(403);
      expect((await request(`/api/admin/layers/${id}`, admin, { method: "DELETE", headers })).status).toBe(403);
    }
    const secondAdmin = await actor();
    expect((await upload(path, "Another session token", secondAdmin)).status).toBe(403);
    const secondToken = (await (await request("/api/admin/uploads", secondAdmin)).json()).csrfToken;
    await owner.query("UPDATE app.users SET role='VIEWER' WHERE id=$1", [secondAdmin.id]);
    expect((await upload(path, "Revoked administrator", secondAdmin, mutationHeaders(secondToken))).status).toBe(403);
  });

  it("imports a projected polygon, preserves Unicode DBF fields and exposes normalized real MVT", async () => {
    const imported = await processUpload({ geometry: "polygon", targetCrs: "EPSG:3857" });
    expect(imported.job.status).toBe("SUCCEEDED");
    const { rows: [layer] } = await owner.query("SELECT state,table_name,srid,source_srid,geometry_type,feature_count,uploaded_by,ST_XMin(bbox) AS minx FROM app.layers WHERE id=$1", [imported.layerId]);
    expect(layer).toMatchObject({ state: "READY", srid: 4326, source_srid: 3857, uploaded_by: admin.id });
    expect(Number(layer.feature_count)).toBe(1);
    expect(layer.geometry_type.toLowerCase()).toBe("polygon");
    expect(Number(layer.minx)).toBeCloseTo(106.81, 3);
    expect(layer.table_name).toMatch(/^layer_[a-f0-9]{32}$/);
    const row = (await owner.query(`SELECT ST_SRID(geom) AS srid,ST_IsValid(geom) AS valid,properties FROM gis.${layer.table_name}`)).rows[0];
    expect(row).toMatchObject({ srid: 4326, valid: true, properties: { name: "Kebun café 中文" } });
    const lon = 106.82, lat = -6.2, z = 12;
    const x = Math.floor((lon + 180) / 360 * 2 ** z), y = Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** z);
    const response = await request(`/api/layers/${imported.layerId}/tiles/${z}/${x}/${y}.pbf`, viewer);
    expect(response.status).toBe(200);
    const tile = new VectorTile(new PbfReader(await response.arrayBuffer()));
    expect(tile.layers.features.length).toBeGreaterThan(0);
    expect(tile.layers.features.feature(0).properties.name).toBe("Kebun café 中文");
    const catalog = await (await request("/api/layers", viewer)).json();
    expect(catalog.layers.some((entry: { id: string }) => entry.id === imported.layerId)).toBe(true);
    const exposed = JSON.stringify(await (await request("/api/admin/layers", admin)).json());
    expect(exposed).not.toContain(storage);
    expect(exposed).not.toContain("postgresql://");
  });

  it.each([
    { geometry: "point", expected: "Point" },
    { geometry: "multipoint", expected: "MultiPoint" },
    { geometry: "line", expected: "LineString" },
    { geometry: "multiline", expected: "MultiLineString" },
    { geometry: "multipolygon", expected: "MultiPolygon" },
  ] as const)("imports $expected geometry using the same pipeline", async ({ geometry, expected }) => {
    const imported = await processUpload({ geometry });
    expect(imported.job.status).toBe("SUCCEEDED");
    const layer = (await owner.query("SELECT geometry_type,feature_count FROM app.layers WHERE id=$1", [imported.layerId])).rows[0];
    expect(layer.geometry_type).toBe(expected);
    expect(Number(layer.feature_count)).toBe(1);
  });

  it("rejects duplicate names without registering a second job or sharing database tables", async () => {
    const first = await processUpload({}, "Duplicate layer name");
    expect(first.job.status).toBe("SUCCEEDED");
    const before = (await readdir(storage)).sort();
    const path = await createShapefileFixture(directory);
    const response = await upload(path, " duplicate LAYER name ");
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("DUPLICATE_NAME");
    expect((await readdir(storage)).sort()).toEqual(before);
    expect((await owner.query("SELECT id FROM app.layers WHERE lower(name)=lower($1)", ["Duplicate layer name"])).rowCount).toBe(1);
  });

  it.each([
    { label: "missing SHX", options: { omit: ["shx"] } },
    { label: "missing DBF", options: { omit: ["dbf"] } },
    { label: "missing CRS", options: { omit: ["prj"] } },
    { label: "unknown CRS", options: { invalidCrs: true } },
    { label: "null geometry", options: { geometry: "null" as const } },
    { label: "invalid geometry", options: { geometry: "invalid" as const } },
  ])("rejects $label without publishing geometry or leaving a partial table", async ({ label, options }) => {
    const path = await createShapefileFixture(directory, options);
    const before = (await owner.query("SELECT id FROM app.layers WHERE state='READY'")).rowCount;
    const response = await upload(path, `Invalid fixture ${label}`);
    if (response.status === 202) {
      const data = await response.json() as { jobId: string; layerId: string };
      layerIds.push(data.layerId);
      await runNextJob(worker);
      const job = await (await request(`/api/admin/jobs/${data.jobId}`, admin)).json() as Job;
      expect(job.status).toBe("FAILED");
      expect(job.error?.code).toBeTruthy();
      expect(job.error?.message).toBeTruthy();
      expect(JSON.stringify(job)).not.toContain(storage);
      const table = `gis.layer_${data.layerId.replaceAll("-", "")}`;
      expect((await owner.query("SELECT to_regclass($1) AS table", [table])).rows[0].table).toBeNull();
      expect((await request(`/api/layers/${data.layerId}`, viewer)).status).toBe(404);
    } else expect([400, 422]).toContain(response.status);
    expect((await owner.query("SELECT id FROM app.layers WHERE state='READY'")).rowCount).toBe(before);
  });

  it("rejects corrupt ZIP streams before registering a layer and cleans temporary uploads", async () => {
    const before = (await readdir(storage).catch(() => [] as string[])).sort();
    const form = new FormData();
    form.set("name", "Not an archive");
    form.set("file", new Blob(["This is not a zip"]), "not-a-zip.zip");
    const response = await request("/api/admin/uploads", admin, { method: "POST", headers: mutationHeaders(), body: form });
    expect([400, 422]).toContain(response.status);
    expect((await readdir(storage)).sort()).toEqual(before);
    expect((await owner.query("SELECT id FROM app.layers WHERE name='Not an archive'")).rowCount).toBe(0);
  });

  it("edits strict metadata, protects hidden tiles and deletes only registered managed resources", async () => {
    const imported = await processUpload();
    expect(imported.job.status).toBe("SUCCEEDED");
    const layerPath = `/api/admin/layers/${imported.layerId}`;
    const metadata = { name: "Renamed layer", description: "Updated description", isVisible: false };
    expect((await patch(imported.layerId, { ...metadata, tableName: "users" })).status).toBe(422);
    expect((await patch(imported.layerId, metadata)).status).toBe(200);
    expect((await request(`/api/layers/${imported.layerId}`, viewer)).status).toBe(404);
    expect((await request(`/api/layers/${imported.layerId}/tiles/0/0/0.pbf`, viewer)).status).toBe(404);
    expect((await request(`/api/layers/${imported.layerId}`, admin)).status).toBe(200);
    const db = (await owner.query("SELECT name,description,is_visible,table_name FROM app.layers WHERE id=$1", [imported.layerId])).rows[0];
    expect(db).toMatchObject({ name: metadata.name, description: metadata.description, is_visible: false });
    const response = await request(layerPath, admin, { method: "DELETE", headers: mutationHeaders() });
    expect(response.status).toBe(202);
    const deletion = await response.json() as { jobId: string };
    await runNextJob(worker);
    expect((await (await request(`/api/admin/jobs/${deletion.jobId}`, admin)).json()).status).toBe("SUCCEEDED");
    expect((await owner.query("SELECT id FROM app.layers WHERE id=$1", [imported.layerId])).rowCount).toBe(0);
    expect((await owner.query("SELECT to_regclass($1) AS table", [`gis.${db.table_name}`])).rows[0].table).toBeNull();
    expect((await request(`/api/layers/${imported.layerId}`, admin)).status).toBe(404);
    expect((await request(layerPath, admin, { method: "DELETE", headers: mutationHeaders() })).status).toBe(404);
  });

  it("treats SQL-looking names as plain data and never accepts database identifiers from requests", async () => {
    const name = "Parcel'; DROP TABLE app.users; --";
    const imported = await processUpload({}, name);
    expect(imported.job.status).toBe("SUCCEEDED");
    const layer = (await owner.query("SELECT name,table_name FROM app.layers WHERE id=$1", [imported.layerId])).rows[0];
    expect(layer.name).toBe(name);
    expect(layer.table_name).toBe(`layer_${imported.layerId.replaceAll("-", "")}`);
    expect((await owner.query("SELECT id FROM app.users WHERE id=$1", [admin.id])).rowCount).toBe(1);
    expect((await patch(imported.layerId, { name, description: "", isVisible: true, sql: "DROP TABLE app.users" })).status).toBe(422);
    expect((await request(`/api/admin/layers/${encodeURIComponent("app.users")}`, admin, { method: "DELETE", headers: mutationHeaders() })).status).toBe(422);
  });

  it("does not grant worker ownership over user accounts or unrelated database tables", async () => {
    expect((await worker.query("SELECT current_user AS role")).rows[0].role).toBe("gis_worker");
    await expect(worker.query("UPDATE app.users SET role='ADMIN' WHERE id=$1", [viewer.id])).rejects.toMatchObject({ code: "42501" });
    await expect(worker.query("DROP TABLE app.users")).rejects.toMatchObject({ code: "42501" });
    await expect(worker.query("SELECT access_token,id_token FROM app.accounts")).rejects.toMatchObject({ code: "42501" });
    await expect(worker.query("SELECT email FROM app.users")).rejects.toMatchObject({ code: "42501" });
    const id = randomUUID();
    layerIds.push(id);
    await owner.query("INSERT INTO app.layers(id,name,layer_type,source_type,state,uploaded_by,table_name) VALUES($1,'Unmanaged fixture','VECTOR','POSTGIS','PROCESSING',$2,$3)", [id, admin.id, `layer_${id.replaceAll("-", "")}`]);
    const response = await request(`/api/admin/layers/${id}`, admin, { method: "DELETE", headers: mutationHeaders() });
    expect(response.status).toBe(409);
    expect((await owner.query("SELECT id FROM app.layers WHERE id=$1", [id])).rowCount).toBe(1);
  });
});


describe("durable vector worker recovery", () => {
  it("can retry an exhausted deletion without stranding its hidden layer", async () => {
    const imported = await processUpload();
    expect(imported.job.status).toBe("SUCCEEDED");
    const endpoint = `/api/admin/layers/${imported.layerId}`;
    const first = await request(endpoint, admin, { method: "DELETE", headers: mutationHeaders() });
    expect(first.status).toBe(202);
    const { jobId } = await first.json();
    await owner.query("UPDATE app.gis_jobs SET status='RUNNING',attempts=3,locked_by=$2,lease_until=now()-interval '1 minute' WHERE id=$1", [jobId, randomUUID()]);
    await recoverExpiredJobs(worker);
    expect((await owner.query("SELECT status FROM app.gis_jobs WHERE id=$1", [jobId])).rows[0].status).toBe("FAILED");
    expect((await request(`/api/layers/${imported.layerId}`, viewer)).status).toBe(404);
    const retry = await request(endpoint, admin, { method: "DELETE", headers: mutationHeaders() });
    expect(retry.status).toBe(202);
    const second = await retry.json();
    expect(second.jobId).not.toBe(jobId);
    expect(await runNextJob(worker)).toBe(true);
    expect((await owner.query("SELECT id FROM app.layers WHERE id=$1", [imported.layerId])).rowCount).toBe(0);
    expect((await owner.query("SELECT id FROM app.audit_logs WHERE action='LAYER_DELETED' AND target_id=$1", [imported.layerId])).rowCount).toBe(1);
  });

  it("fences an expired claimant, cleans its staging work and retries without duplicate publication", async () => {
    const accepted = await queueUpload();
    const guard = await owner.connect();
    let running: Promise<boolean> | undefined;
    try {
      // Hold the same lock used just before publication, allowing deterministic lease expiry.
      await guard.query("SELECT pg_advisory_lock(73429101)");
      running = runNextJob(worker);
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await owner.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=73429101 AND NOT granted");
        if (result.rowCount) { waiting = true; break; }
        await delay(50);
      }
      expect(waiting).toBe(true);
      const original = (await owner.query("SELECT locked_by,payload FROM app.gis_jobs WHERE id=$1", [accepted.jobId])).rows[0];
      expect(original.locked_by).toMatch(/^[a-f0-9-]{36}$/);
      const stage = `gis_staging.stage_${original.locked_by.replaceAll("-", "")}`;
      expect((await owner.query("SELECT to_regclass($1) AS table", [stage])).rows[0].table).not.toBeNull();
      await owner.query("UPDATE app.gis_jobs SET lease_until=now()-interval '1 minute' WHERE id=$1", [accepted.jobId]);
      await recoverExpiredJobs(worker);
      const recovered = (await owner.query("SELECT status,locked_by,attempts FROM app.gis_jobs WHERE id=$1", [accepted.jobId])).rows[0];
      expect(recovered).toMatchObject({ status: "QUEUED", locked_by: null, attempts: 1 });
      expect((await owner.query("SELECT to_regclass($1) AS table", [stage])).rows[0].table).toBeNull();
      expect((await stat(join(storage, original.payload.uploadId, "archive.zip"))).isFile()).toBe(true);
      await guard.query("SELECT pg_advisory_unlock(73429101)");
      expect(await running).toBe(true);
      const finalTable = `gis.layer_${accepted.layerId.replaceAll("-", "")}`;
      expect((await owner.query("SELECT to_regclass($1) AS table", [finalTable])).rows[0].table).toBeNull();
      expect((await owner.query("SELECT id FROM app.audit_logs WHERE target_id=$1 AND action='LAYER_UPLOADED'", [accepted.layerId])).rowCount).toBe(0);
      expect(await runNextJob(worker)).toBe(true);
      expect((await owner.query("SELECT status,attempts FROM app.gis_jobs WHERE id=$1", [accepted.jobId])).rows[0]).toMatchObject({ status: "SUCCEEDED", attempts: 2 });
      expect((await owner.query("SELECT id FROM app.audit_logs WHERE target_id=$1 AND action='LAYER_UPLOADED'", [accepted.layerId])).rowCount).toBe(1);
      await expect(stat(join(storage, original.payload.uploadId))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await guard.query("SELECT pg_advisory_unlock(73429101)").catch(() => undefined);
      guard.release();
      await running;
    }
  }, 30_000);

  it("marks exhausted leases failed and removes source files, partial staging and old orphan directories", async () => {
    const accepted = await queueUpload();
    const token = randomUUID();
    const work = join(storage, "tmp", accepted.jobId, token);
    await mkdir(work, { recursive: true });
    await writeFile(join(work, "partial.txt"), "Interrupted worker");
    const stage = `stage_${token.replaceAll("-", "")}`;
    await worker.query(`CREATE TABLE gis_staging.${stage}(id integer)`);
    await owner.query("UPDATE app.gis_jobs SET status='RUNNING',attempts=3,locked_by=$2,lease_until=now()-interval '1 minute' WHERE id=$1", [accepted.jobId, token]);
    const uploadId = (await owner.query("SELECT payload->>'uploadId' AS id FROM app.gis_jobs WHERE id=$1", [accepted.jobId])).rows[0].id;
    const orphan = join(storage, randomUUID());
    const orphanAttempt = join(storage, "tmp", randomUUID(), randomUUID());
    for (const path of [orphan, orphanAttempt]) {
      await mkdir(path, { recursive: true });
      await writeFile(join(path, "partial.zip"), "Uncommitted request");
      const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
      await utimes(path, old, old);
    }
    await recoverExpiredJobs(worker);
    expect((await owner.query("SELECT status,error_code FROM app.gis_jobs WHERE id=$1", [accepted.jobId])).rows[0]).toMatchObject({ status: "FAILED", error_code: "JOB_EXPIRED" });
    expect((await owner.query("SELECT state FROM app.layers WHERE id=$1", [accepted.layerId])).rows[0].state).toBe("FAILED");
    expect((await owner.query("SELECT to_regclass($1) AS table", [`gis_staging.${stage}`])).rows[0].table).toBeNull();
    for (const path of [join(storage, uploadId), work, orphan, orphanAttempt]) await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await runNextJob(worker)).toBe(false);
  });

  it("preserves queued sources during sweeping and refuses imports after the administrator is revoked", async () => {
    const accepted = await queueUpload();
    const uploadId = (await owner.query("SELECT payload->>'uploadId' AS id FROM app.gis_jobs WHERE id=$1", [accepted.jobId])).rows[0].id;
    const uploadPath = join(storage, uploadId);
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await utimes(uploadPath, old, old);
    await recoverExpiredJobs(worker);
    expect((await stat(join(uploadPath, "archive.zip"))).isFile()).toBe(true);
    await owner.query("UPDATE app.users SET role='VIEWER' WHERE id=$1", [admin.id]);
    try {
      expect(await runNextJob(worker)).toBe(true);
      expect((await owner.query("SELECT status,error_code FROM app.gis_jobs WHERE id=$1", [accepted.jobId])).rows[0]).toMatchObject({ status: "FAILED", error_code: "FORBIDDEN" });
      expect((await owner.query("SELECT state FROM app.layers WHERE id=$1", [accepted.layerId])).rows[0].state).toBe("FAILED");
      await expect(stat(uploadPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await owner.query("SELECT id FROM app.audit_logs WHERE target_id=$1 AND action='LAYER_UPLOADED'", [accepted.layerId])).rowCount).toBe(0);
    } finally {
      await owner.query("UPDATE app.users SET role='ADMIN' WHERE id=$1", [admin.id]);
    }
  });
});
