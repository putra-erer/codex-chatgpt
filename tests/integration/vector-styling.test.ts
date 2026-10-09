import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { managedLayerMarker } from "@/lib/gis/admin";
import { defaultVectorStyle, vectorStyleSchema } from "@/lib/gis/style";
import type { GeometryType, MapLayer } from "@/lib/gis/types";

type Actor = { id: string; token: string };
type Fixture = { id: string; table: string; geometry: GeometryType };
let owner: Pool;
let server: ChildProcess;
let baseUrl: string;
let port: number;
let admin: Actor;
let viewer: Actor;
let pending: Actor;
let rejected: Actor;
let csrfToken: string;
const secret = randomBytes(32).toString("hex");
const actorIds: string[] = [];
const fixtures: Fixture[] = [];

async function actor(status = "APPROVED", role = "ADMIN"): Promise<Actor> {
  const id = randomUUID(), token = randomBytes(32).toString("hex"), subject = `styling-${id}`;
  await owner.query(`INSERT INTO app.users(id,email,name,google_id,email_verified,status,role,approved_at)
    VALUES($1,$2,'Style integration user',$3,now(),$4::app.user_status,$5,CASE WHEN $4::app.user_status='APPROVED' THEN now() ELSE NULL END)`,
  [id, `${id}@style.example.test`, subject, status, role]);
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

function write(path: string, method: string, body: unknown, user: Actor | null = admin, token = csrfToken, origin = baseUrl) {
  return request(path, user, {
    method, body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin, "x-gis-csrf": token },
  });
}

function stylePath(fixture: Fixture) { return `/api/admin/layers/${fixture.id}/style`; }
function attributesPath(fixture: Fixture, field?: string) {
  return `/api/admin/layers/${fixture.id}/attributes${field === undefined ? "" : `?field=${encodeURIComponent(field)}`}`;
}

async function fixture(geometry: GeometryType = "Polygon", properties: Record<string, unknown>[] = [{ name: "Kebun café 中文", land_use: "Forest", block_code: "A01" }]): Promise<Fixture> {
  const id = randomUUID(), table = `layer_${id.replaceAll("-", "")}`;
  const geometries: Record<GeometryType, string> = {
    Point: "POINT(106.82 -6.2)", MultiPoint: "MULTIPOINT((106.82 -6.2),(106.83 -6.2))",
    LineString: "LINESTRING(106.81 -6.21,106.83 -6.19)", MultiLineString: "MULTILINESTRING((106.81 -6.21,106.83 -6.19))",
    Polygon: "POLYGON((106.81 -6.21,106.83 -6.21,106.83 -6.19,106.81 -6.19,106.81 -6.21))",
    MultiPolygon: "MULTIPOLYGON(((106.81 -6.21,106.83 -6.21,106.83 -6.19,106.81 -6.19,106.81 -6.21)))",
  };
  // These UUID-derived tables are created only after the runner's database isolation check.
  await owner.query(`CREATE TABLE gis.${table}(feature_id bigint PRIMARY KEY, properties jsonb NOT NULL, geom geometry(Geometry,4326) NOT NULL)`);
  fixtures.push({ id, table, geometry });
  await owner.query(`INSERT INTO gis.${table} SELECT ordinal,properties,ST_GeomFromText($2,4326)
    FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS source(properties,ordinal)`, [JSON.stringify(properties), geometries[geometry]]);
  await owner.query(`GRANT SELECT ON gis.${table} TO gis_app`);
  await owner.query(`INSERT INTO app.layers(id,name,layer_type,source_type,table_name,srid,state,geometry_type,feature_count,bbox,uploaded_by,storage_metadata)
    VALUES($1,$2,'VECTOR','SHP',$3,4326,'READY',$4,$5,ST_MakeEnvelope(106.81,-6.21,106.83,-6.19,4326),$6,$7::jsonb)`,
  [id, `Isolated styling ${id}`, table, geometry, properties.length, admin.id, JSON.stringify({ managedBy: managedLayerMarker, uploadId: randomUUID() })]);
  return { id, table, geometry };
}

async function stopServer() {
  if (server && server.exitCode === null) {
    const ended = once(server, "exit");
    server.kill("SIGTERM");
    const timeout = setTimeout(() => server.kill("SIGKILL"), 5_000);
    await ended;
    clearTimeout(timeout);
  }
}

async function startServer() {
  server = spawn(process.execPath, [resolve(".next/standalone/server.js")], {
    env: { ...process.env, NODE_ENV: "production", HOSTNAME: "127.0.0.1", PORT: String(port), AUTH_URL: baseUrl, AUTH_SECRET: secret, GOOGLE_CLIENT_ID: "styling-integration", GOOGLE_CLIENT_SECRET: "styling-integration", SUPER_ADMIN_EMAILS: "" },
    stdio: "ignore",
  });
  let startError = false;
  server.on("error", () => { startError = true; });
  for (let attempt = 0; attempt < 150; attempt++) {
    if (startError || server.exitCode !== null) throw new Error("Styling integration HTTP server exited.");
    try { if ((await request("/login")).status === 200) return; } catch {}
    await delay(100);
  }
  throw new Error("Styling integration HTTP server did not become ready.");
}

beforeAll(async () => {
  const database = process.env.PORTAL_INTEGRATION_DATABASE;
  if (!database || !/^portal_test_[a-f0-9]{32}$/.test(database)) throw new Error("Use npm run test:integration to create an isolated database.");
  owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
  expect((await owner.query("SELECT current_database() AS name")).rows[0].name).toBe(database);
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Cannot allocate test server port.");
  port = address.port;
  await new Promise<void>((done, reject) => listener.close((error) => error ? reject(error) : done()));
  baseUrl = `http://127.0.0.1:${port}`;
  await startServer();
  admin = await actor();
  viewer = await actor("APPROVED", "VIEWER");
  pending = await actor("PENDING", "ADMIN");
  rejected = await actor("REJECTED", "ADMIN");
  const configuration = await request("/api/admin/layers", admin);
  expect(configuration.status).toBe(200);
  csrfToken = (await configuration.json()).csrfToken;
  expect(csrfToken).toMatch(/^[a-f0-9]{64}$/);
}, 30_000);

afterAll(async () => {
  await stopServer();
  if (owner) {
    // Remove fixture-owned resources only; the isolated database runner removes the database.
    for (const { id, table } of fixtures) {
      if (!/^layer_[a-f0-9]{32}$/.test(table)) throw new Error("Unsafe fixture table name.");
      await owner.query("DELETE FROM app.layers WHERE id=$1", [id]);
      await owner.query(`DROP TABLE IF EXISTS gis.${table}`);
    }
    if (actorIds.length) {
      await owner.query("DELETE FROM app.audit_logs WHERE user_id=ANY($1::uuid[])", [actorIds]);
      await owner.query("DELETE FROM app.users WHERE id=ANY($1::uuid[])", [actorIds]);
    }
    await owner.end();
  }
});

describe("production HTTP vector styling and layer organization", () => {
  it("upgrades a populated Phase 4 database without changing styles, geometries or authentication records", async () => {
    // This extra database starts at Phase 4. Never undo migrations or remove
    // columns from the runner's database, which other integration suites share.
    const databaseName = `portal_test_${randomUUID().replaceAll("-", "")}`;
    const url = new URL(process.env.MIGRATION_DATABASE_URL!);
    url.pathname = `/${databaseName}`;
    const database = new Client({ connectionString: url.toString() });
    let created = false;
    let connected = false;
    try {
      await owner.query(`CREATE DATABASE "${databaseName}"`);
      created = true;
      await database.connect();
      connected = true;
      expect((await database.query("SELECT current_database() AS name")).rows[0].name).toBe(databaseName);
      const migrations = readMigrationFiles({ migrationsFolder: resolve("migrations") });
      expect(migrations).toHaveLength(7);
      for (const migration of migrations.slice(0, 6)) {
        await database.query("BEGIN");
        for (const statement of migration.sql) await database.query(statement);
        await database.query("COMMIT");
      }
      const userId = randomUUID(), token = randomBytes(32).toString("hex");
      await database.query(`INSERT INTO app.users(id,email,name,google_id,email_verified,status,role,approved_at)
        VALUES($1::uuid,'migration@style.example.test','Existing administrator',$1::uuid::text,now(),'APPROVED','ADMIN',now())`, [userId]);
      await database.query("INSERT INTO app.accounts(user_id,type,provider,provider_account_id) VALUES($1::uuid,'oidc','google',$1::uuid::text)", [userId]);
      await database.query("INSERT INTO app.sessions(session_token,user_id,expires) VALUES($1,$2,now()+interval '1 hour')", [token, userId]);
      await database.query("INSERT INTO app.audit_logs(user_id,action,target_id) VALUES($1::uuid,'LOGIN',$1::uuid::text)", [userId]);
      const legacy = [
        { id: randomUUID(), style: { color: "#337AB7", opacity: 0.55, radius: 9 }, visible: true },
        { id: randomUUID(), style: {}, visible: false },
      ];
      for (const [position, layer] of legacy.entries()) {
        const table = `layer_${layer.id.replaceAll("-", "")}`;
        await database.query(`CREATE TABLE gis.${table}(feature_id bigint PRIMARY KEY,properties jsonb NOT NULL,geom geometry(Point,4326) NOT NULL)`);
        await database.query(`INSERT INTO gis.${table} VALUES(1,'{"name":"Existing café 中文","area":23.5}',ST_SetSRID(ST_MakePoint(106.82,-6.2),4326))`);
        await database.query(`INSERT INTO app.layers(id,name,layer_type,source_type,table_name,srid,state,geometry_type,feature_count,bbox,uploaded_by,style_json,is_visible,storage_metadata,created_at)
          VALUES($1,$2,'VECTOR','SHP',$3,4326,'READY','Point',1,ST_MakeEnvelope(106.82,-6.2,106.82,-6.2,4326),$4,$5::jsonb,$6,$7::jsonb,'2026-01-01'::timestamptz+$8::integer*interval '1 day')`,
        [layer.id, `Existing ${position}`, table, userId, JSON.stringify(layer.style), layer.visible,
          JSON.stringify({ managedBy: managedLayerMarker, uploadId: randomUUID(), originalName: "original.zip" }), position]);
      }
      const authentication = async () => Promise.all(["users", "accounts", "sessions", "audit_logs"].map(async (table) =>
        (await database.query(`SELECT to_jsonb(record) AS value FROM app.${table} AS record ORDER BY to_jsonb(record)::text`)).rows));
      const layerData = async () => (await database.query(`SELECT to_jsonb(record)-'updated_at'-'sort_order'-'default_visible'-'group_name' AS value
        FROM app.layers AS record ORDER BY created_at,id`)).rows;
      const geometries = async () => Promise.all(legacy.map(async (layer) =>
        (await database.query(`SELECT feature_id,properties,encode(ST_AsEWKB(geom),'hex') AS geometry FROM gis.layer_${layer.id.replaceAll("-", "")}`)).rows));
      const before = { authentication: await authentication(), layers: await layerData(), geometries: await geometries() };
      await database.query("BEGIN");
      for (const statement of migrations[6].sql) await database.query(statement);
      await database.query("COMMIT");
      expect(await authentication()).toEqual(before.authentication);
      expect(await layerData()).toEqual(before.layers);
      expect(await geometries()).toEqual(before.geometries);
      expect((await database.query("SELECT id,sort_order,group_name,default_visible FROM app.layers ORDER BY sort_order,created_at,id")).rows)
        .toEqual(legacy.map((layer, index) => ({ id: layer.id, sort_order: index, group_name: null, default_visible: layer.visible })));
    } finally {
      if (connected) await database.end();
      if (created) await owner.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    }
  }, 30_000);

  it("protects all new read and write endpoints with live approved administrator authorization", async () => {
    const layer = await fixture();
    const writes = [
      [stylePath(layer), "PUT", { style: defaultVectorStyle("Polygon") }],
      [`/api/admin/layers/${layer.id}/settings`, "PATCH", { groupName: "Boundaries", defaultVisible: false }],
      ["/api/admin/layers/order", "POST", { layerId: layer.id, direction: "up" }],
      ["/api/admin/layers/groups", "PATCH", { from: "Boundaries", to: "Estates" }],
    ] as const;
    for (const user of [null, viewer, pending, rejected]) {
      for (const path of [stylePath(layer), attributesPath(layer), attributesPath(layer, "name")]) {
        expect((await request(path, user)).status).toBe(user ? 403 : 401);
      }
      for (const [path, method, body] of writes) expect((await write(path, method, body, user)).status).toBe(user ? 403 : 401);
    }
    for (const user of [pending, rejected]) expect((await request(`/api/layers/${layer.id}`, user)).status).toBe(403);
    expect((await owner.query("SELECT style_json,group_name,default_visible FROM app.layers WHERE id=$1", [layer.id])).rows[0])
      .toEqual({ style_json: {}, group_name: null, default_visible: true });
  });

  it("protects the editor page even when its URL is opened directly", async () => {
    const layer = await fixture();
    for (const [user, landing] of [[null, "/login"], [viewer, "/access-denied"], [pending, "/pending"], [rejected, "/access-denied"]] as const) {
      const response = await request(`/admin/layers/${layer.id}/style`, user);
      expect(response.status).toBe(307);
      expect(new URL(response.headers.get("location")!, baseUrl).pathname).toBe(landing);
    }
    expect((await request(`/admin/layers/${layer.id}/style`, admin)).status).toBe(200);
  });

  it("binds every mutation to the administrator session and the portal origin", async () => {
    const layer = await fixture();
    const writes = [
      [stylePath(layer), "PUT", { style: defaultVectorStyle("Polygon") }],
      [`/api/admin/layers/${layer.id}/settings`, "PATCH", { groupName: "Boundaries", defaultVisible: false }],
      ["/api/admin/layers/order", "POST", { layerId: layer.id, direction: "down" }],
      ["/api/admin/layers/groups", "PATCH", { from: "Boundaries", to: "Estates" }],
    ] as const;
    for (const [token, origin] of [["", baseUrl], ["forged", baseUrl], [csrfToken, "https://other.example"]]) {
      for (const [path, method, body] of writes) expect((await write(path, method, body, admin, token, origin)).status).toBe(403);
    }
    const secondAdmin = await actor();
    for (const [path, method, body] of writes) expect((await write(path, method, body, secondAdmin)).status).toBe(403);
    const secondToken = (await (await request(stylePath(layer), secondAdmin)).json()).csrfToken;
    await owner.query("UPDATE app.users SET role='VIEWER' WHERE id=$1", [secondAdmin.id]);
    for (const [path, method, body] of writes) expect((await write(path, method, body, secondAdmin, secondToken)).status).toBe(403);
    expect((await request(attributesPath(layer), secondAdmin)).status).toBe(403);
  });

  it.each(["Polygon", "MultiPolygon", "LineString", "MultiLineString", "Point", "MultiPoint"] as const)("persists %s style while leaving feature geometry, attributes and storage metadata intact", async (geometry) => {
    const layer = await fixture(geometry);
    const before = (await owner.query(`SELECT feature_id,properties,encode(ST_AsEWKB(geom),'hex') AS geometry FROM gis.${layer.table}`)).rows;
    const registryBefore = (await owner.query("SELECT table_name,storage_metadata,bbox::text,feature_count FROM app.layers WHERE id=$1", [layer.id])).rows[0];
    const style = { ...defaultVectorStyle(geometry), color: "#708238", opacity: 0.55, width: 3.5, radius: 9, strokeColor: "#163A2B", strokeWidth: 3, strokeOpacity: 0.7, minZoom: 3, maxZoom: 21 };
    const saved = await write(stylePath(layer), "PUT", { style });
    expect(saved.status).toBe(200);
    expect((await saved.json()).layer.style).toEqual(style);
    expect((await (await request(stylePath(layer), admin)).json()).layer.style).toEqual(style);
    const viewerResponse = await request(`/api/layers/${layer.id}`, viewer);
    expect(viewerResponse.status).toBe(200);
    expect((await viewerResponse.json()).style).toEqual(style);
    expect((await owner.query("SELECT style_json FROM app.layers WHERE id=$1", [layer.id])).rows[0].style_json).toEqual(style);
    expect((await owner.query(`SELECT feature_id,properties,encode(ST_AsEWKB(geom),'hex') AS geometry FROM gis.${layer.table}`)).rows).toEqual(before);
    expect((await owner.query("SELECT table_name,storage_metadata,bbox::text,feature_count FROM app.layers WHERE id=$1", [layer.id])).rows[0]).toEqual(registryBefore);
    expect((await owner.query("SELECT 1 FROM app.audit_logs WHERE user_id=$1 AND target_id=$2 AND action='LAYER_UPDATED'", [admin.id, layer.id])).rowCount).toBe(1);
  });

  it("keeps stored style after a new login session and production server restart", async () => {
    const layer = await fixture("LineString");
    const style = { ...defaultVectorStyle("LineString"), color: "#8B6F47", width: 4, dash: "dashed" as const };
    expect((await write(stylePath(layer), "PUT", { style })).status).toBe(200);
    const secondSession = { ...admin, token: randomBytes(32).toString("hex") };
    await owner.query("INSERT INTO app.sessions(session_token,user_id,expires) VALUES($1,$2,now()+interval '1 hour')", [secondSession.token, admin.id]);
    await stopServer();
    await startServer();
    const response = await request(stylePath(layer), secondSession);
    expect(response.status).toBe(200);
    expect((await response.json()).layer.style).toEqual(style);
  });

  it("rejects expressions, unknown properties, wrong geometry families, invalid colors and unsafe ranges", async () => {
    const layer = await fixture();
    const style = defaultVectorStyle("Polygon");
    const invalid = [
      { ...style, color: "red" }, { ...style, color: ["get", "name"] }, { ...style, opacity: 1.01 },
      { ...style, opacity: -0.1 }, { ...style, width: 1000 }, { ...style, radius: 0 },
      { ...style, strokeWidth: -1 }, { ...style, type: "line" }, { ...style, version: 2 },
      { ...style, minZoom: 15, maxZoom: 5 }, { ...style, paint: { "fill-color": "#000000" } },
      { ...style, label: { ...style.label, enabled: true, field: null } },
      { ...style, label: { ...style.label, size: 1000 } },
      { ...style, label: { ...style.label, minZoom: 20, maxZoom: 5 } },
      { ...style, mode: "categorized", category: null },
    ];
    for (const candidate of invalid) expect((await write(stylePath(layer), "PUT", { style: candidate })).status).toBe(422);
    expect((await write(stylePath(layer), "PUT", { style, tableName: "users" })).status).toBe(422);
    expect((await owner.query("SELECT style_json FROM app.layers WHERE id=$1", [layer.id])).rows[0].style_json).toEqual({});
  });

  it("reads legacy and missing styles using safe fallbacks without rewriting stored JSON", async () => {
    const layer = await fixture("Point");
    for (const stored of [{}, { color: "#337AB7", opacity: 0.3, radius: 9 }, { color: ["get", "evil"], radius: -50, unexpected: "ignored" }]) {
      await owner.query("UPDATE app.layers SET style_json=$2::jsonb WHERE id=$1", [layer.id, JSON.stringify(stored)]);
      const response = await request(stylePath(layer), admin);
      expect(response.status).toBe(200);
      const returned = (await response.json()).layer.style;
      expect(vectorStyleSchema.safeParse(returned).success).toBe(true);
      expect(returned.type).toBe("point");
      if (stored.color === "#337AB7") expect(returned).toMatchObject({ color: "#337AB7", opacity: 0.3, radius: 9 });
      expect((await owner.query("SELECT style_json FROM app.layers WHERE id=$1", [layer.id])).rows[0].style_json).toEqual(stored);
    }
  });

  it("returns only displayable scalar fields and preserves typed distinct category values", async () => {
    const layer = await fixture("Polygon", [
      { name: "First", mixed: 1, secret_token: "hidden", nested: { value: 1 }, array: [1], nothing: null, _internal: "hidden", geom: "hidden" },
      { name: "Second", mixed: "1" }, { name: "Third", mixed: true }, { name: "Fourth", mixed: "1" },
    ]);
    const fields = await (await request(attributesPath(layer), admin)).json();
    expect(fields.fields).toEqual(expect.arrayContaining(["name", "mixed"]));
    for (const name of ["secret_token", "nested", "array", "nothing", "_internal", "geom"]) expect(fields.fields).not.toContain(name);
    expect(fields.sampled).toBe(false);
    const categories = await (await request(attributesPath(layer, "mixed"), admin)).json();
    expect(categories.values).toHaveLength(3);
    expect(categories.values).toEqual(expect.arrayContaining([1, "1", true]));
    expect(categories.truncated).toBe(false);
    expect(categories.sampled).toBe(false);
  });

  it("persists categorized colors and label settings only for existing safe attributes", async () => {
    const layer = await fixture("Polygon", [{ land_use: "Forest", block_code: "A01" }, { land_use: "Water", block_code: "A02" }]);
    const style = {
      ...defaultVectorStyle("Polygon"), mode: "categorized" as const,
      category: { field: "land_use", categories: [{ value: "Forest", color: "#163A2B" }, { value: "Water", color: "#337AB7" }], otherColor: "#8B6F47" },
      label: { ...defaultVectorStyle("Polygon").label, enabled: true, field: "block_code", size: 15, color: "#2F6B45", haloWidth: 2, minZoom: 14, maxZoom: 22 },
    };
    expect((await write(stylePath(layer), "PUT", { style })).status).toBe(200);
    const viewerResponse = await request(`/api/layers/${layer.id}`, viewer);
    expect(viewerResponse.status).toBe(200);
    expect((await viewerResponse.json()).style).toEqual(style);
    for (const field of ["missing_field", "secret_token", "geometry", "_internal"]) {
      expect((await write(stylePath(layer), "PUT", { style: { ...style, category: { ...style.category, field } } })).status).toBe(422);
      expect((await write(stylePath(layer), "PUT", { style: { ...style, label: { ...style.label, field } } })).status).toBe(422);
    }
    expect((await write(stylePath(layer), "PUT", { style: { ...style, category: { ...style.category, categories: [{ value: "Forest", color: "#163A2B" }, { value: "Forest", color: "#337AB7" }] } } })).status).toBe(422);
    const invented = await write(stylePath(layer), "PUT", { style: { ...style, category: {
      ...style.category, categories: [{ value: "Invented category", color: "#163A2B" }],
    } } });
    expect(invented.status).toBe(422);
    expect((await invented.json()).code).toBe("INVALID_CATEGORIES");
    expect((await (await request(stylePath(layer), admin)).json()).layer.style).toEqual(style);
    const disabled = { ...style, label: { ...style.label, enabled: false } };
    expect((await write(stylePath(layer), "PUT", { style: disabled })).status).toBe(200);
    expect((await (await request(stylePath(layer), admin)).json()).layer.style.label.enabled).toBe(false);
  });

  it("treats attribute names as parameters even when they contain SQL-looking text", async () => {
    const field = "land'); DROP TABLE app.users; --";
    const layer = await fixture("Point", [{ [field]: "Forest", name: "Safe fixture" }]);
    const response = await request(attributesPath(layer, field), admin);
    expect(response.status).toBe(200);
    expect((await response.json()).values).toEqual(["Forest"]);
    const style = { ...defaultVectorStyle("Point"), mode: "categorized" as const, category: { field, categories: [{ value: "Forest", color: "#163A2B" }], otherColor: "#708238" } };
    expect((await write(stylePath(layer), "PUT", { style })).status).toBe(200);
    expect((await owner.query("SELECT count(*)::integer AS count FROM app.users WHERE id=$1", [admin.id])).rows[0].count).toBe(1);
    expect((await owner.query(`SELECT properties FROM gis.${layer.table}`)).rows[0].properties[field]).toBe("Forest");
  });

  it("bounds category, field and feature sampling without returning the full dataset", async () => {
    const values = await fixture("Point", Array.from({ length: 65 }, (_, index) => ({ category: `Category ${String(index).padStart(3, "0")}` })));
    const categoryResponse = await request(attributesPath(values, "category"), admin);
    expect(categoryResponse.status).toBe(200);
    const categories = await categoryResponse.json();
    expect(categories.values).toHaveLength(50);
    expect(categories.truncated).toBe(true);
    const manyFields = await fixture("Point", [Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`field_${index}`, index]))]);
    expect((await (await request(attributesPath(manyFields), admin)).json()).fields.length).toBeLessThanOrEqual(100);
    const sampled = await fixture("Point", [{ category: "Visible sample" }]);
    await owner.query(`INSERT INTO gis.${sampled.table} SELECT n,'{"category":"Visible sample"}'::jsonb,ST_SetSRID(ST_MakePoint(106.82,-6.2),4326) FROM generate_series(2,10001) n`);
    const result = await (await request(attributesPath(sampled, "category"), admin)).json();
    expect(result.values).toEqual(["Visible sample"]);
    expect(result.sampled).toBe(true);
    const style = { ...defaultVectorStyle("Point"), mode: "categorized" as const, category: { field: "category", categories: Array.from({ length: 51 }, (_, index) => ({ value: `Category ${index}`, color: "#163A2B" })), otherColor: "#708238" } };
    expect((await write(stylePath(values), "PUT", { style })).status).toBe(422);
  });

  it("times out blocked attribute queries and serves the next request after the lock is released", async () => {
    const layer = await fixture("Point");
    const blocker = await owner.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(`LOCK TABLE gis.${layer.table} IN ACCESS EXCLUSIVE MODE`);
      const response = await request(attributesPath(layer, "name"), admin);
      expect(response.status).toBe(503);
      expect((await response.json()).code).toBe("ATTRIBUTE_QUERY_TIMEOUT");
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
    expect((await request(attributesPath(layer, "name"), admin)).status).toBe(200);
  });

  it("rejects missing, unregistered and processing layer targets without leaking internals", async () => {
    const layer = await fixture();
    const invalidId = { ...layer, id: "not-a-uuid" };
    expect((await request(stylePath(invalidId), admin)).status).toBe(422);
    expect((await request(attributesPath(invalidId), admin)).status).toBe(422);
    expect((await write(stylePath(invalidId), "PUT", { style: defaultVectorStyle("Polygon") })).status).toBe(422);
    const unknown = { ...layer, id: randomUUID() };
    expect((await request(stylePath(unknown), admin)).status).toBe(404);
    expect((await request(attributesPath(unknown), admin)).status).toBe(404);
    await owner.query("UPDATE app.layers SET storage_metadata='{}'::jsonb WHERE id=$1", [layer.id]);
    expect((await request(attributesPath(layer), admin)).status).toBe(409);
    expect((await write(stylePath(layer), "PUT", { style: defaultVectorStyle("Polygon") })).status).toBe(409);
    await owner.query("UPDATE app.layers SET storage_metadata=$2::jsonb,state='PROCESSING' WHERE id=$1", [layer.id, JSON.stringify({ managedBy: managedLayerMarker })]);
    const response = await request(stylePath(layer), admin);
    expect(response.status).toBe(409);
    const body = await response.text();
    expect(body).not.toContain(layer.table);
    expect(body).not.toContain("postgresql://");
    expect(body).not.toContain("SELECT");
  });

  it("persists ordering atomically and returns the same order to administrators and viewers", async () => {
    const first = await fixture("Point"), second = await fixture("LineString"), third = await fixture("Polygon");
    await owner.query("UPDATE app.layers SET sort_order=100000 WHERE id=ANY($1::uuid[])", [fixtures.map((item) => item.id)]);
    for (const [index, entry] of [first, second, third].entries()) await owner.query("UPDATE app.layers SET sort_order=$2 WHERE id=$1", [entry.id, index]);
    const response = await write("/api/admin/layers/order", "POST", { layerId: third.id, direction: "up" });
    expect(response.status).toBe(200);
    const moved = (await response.json()).layers as { id: string; sortOrder: number }[];
    expect(moved.slice(0, 3).map((item) => item.id)).toEqual([first.id, third.id, second.id]);
    const catalog = (await (await request("/api/layers", viewer)).json()).layers as MapLayer[];
    expect(catalog.slice(0, 3).map((item) => item.id)).toEqual([first.id, third.id, second.id]);
    expect((await write("/api/admin/layers/order", "POST", { layerId: first.id, direction: "up" })).status).toBe(200);
    const concurrent = await Promise.all([
      write("/api/admin/layers/order", "POST", { layerId: third.id, direction: "down" }),
      write("/api/admin/layers/order", "POST", { layerId: first.id, direction: "down" }),
    ]);
    expect(concurrent.map((item) => item.status)).toEqual([200, 200]);
    const registry = (await owner.query("SELECT id,sort_order FROM app.layers WHERE id=ANY($1::uuid[]) ORDER BY sort_order,created_at,id", [[first.id, second.id, third.id]])).rows;
    expect(new Set(registry.map((item) => item.sort_order)).size).toBe(3);
    expect(registry.every((item) => item.sort_order >= 0)).toBe(true);
    expect((await write("/api/admin/layers/order", "POST", { layerId: first.id, direction: "sideways" })).status).toBe(422);
    expect((await write("/api/admin/layers/order", "POST", { layerId: first.id, direction: "up", sortOrder: -100 })).status).toBe(422);
  });

  it("assigns and renames groups while keeping default visibility separate from publication access", async () => {
    const first = await fixture(), second = await fixture("Point");
    const group = `Boundaries ${randomUUID()}`;
    for (const layer of [first, second]) {
      const response = await write(`/api/admin/layers/${layer.id}/settings`, "PATCH", { groupName: group, defaultVisible: false });
      expect(response.status).toBe(200);
      expect((await response.json()).layer).toMatchObject({ groupName: group, defaultVisible: false, isVisible: true });
      expect((await request(`/api/layers/${layer.id}`, viewer)).status).toBe(200);
    }
    const renamed = `Estate's "boundaries" ${randomUUID()}`;
    const rename = await write("/api/admin/layers/groups", "PATCH", { from: group, to: renamed });
    expect(rename.status).toBe(200);
    for (const layer of [first, second]) expect((await owner.query("SELECT group_name FROM app.layers WHERE id=$1", [layer.id])).rows[0].group_name).toBe(renamed);
    await owner.query("UPDATE app.layers SET is_visible=false WHERE id=$1", [first.id]);
    expect((await write(`/api/admin/layers/${first.id}/settings`, "PATCH", { groupName: null, defaultVisible: true })).status).toBe(200);
    expect((await request(`/api/layers/${first.id}`, viewer)).status).toBe(404);
    expect((await request(`/api/layers/${first.id}/tiles/0/0/0.pbf`, viewer)).status).toBe(404);
    expect((await request(stylePath(first), admin)).status).toBe(200);
    const catalog = (await (await request("/api/layers", viewer)).json()).layers as MapLayer[];
    expect(catalog.some((item) => item.id === first.id)).toBe(false);
    expect(catalog.find((item) => item.id === second.id)).toMatchObject({ defaultVisible: false, groupName: renamed });
    for (const invalid of [{ groupName: "x".repeat(101), defaultVisible: true }, { groupName: "Invalid\nGroup", defaultVisible: true }, { groupName: null, defaultVisible: "false" }, { groupName: null, defaultVisible: true, isVisible: true }]) {
      expect((await write(`/api/admin/layers/${first.id}/settings`, "PATCH", invalid)).status).toBe(422);
    }
  });
});
