import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type Status = "PENDING" | "APPROVED" | "REJECTED";
type Role = "VIEWER" | "ADMIN";
type Fixture = { id: string; token: string };

let owner: Pool;
let server: ChildProcess;
let baseUrl: string;
const fixtureIds: string[] = [];

async function createFixture(status: Status, role: Role, expired = false): Promise<Fixture> {
  const id = randomUUID();
  const subject = `http-test-${id}`;
  const token = randomBytes(32).toString("hex");
  await owner.query(
    `INSERT INTO app.users (id,email,name,google_id,email_verified,status,role,approved_at)
     VALUES ($1,$2,'HTTP test user',$3,now(),$4::app.user_status,$5,CASE WHEN $4::app.user_status='APPROVED' THEN now() ELSE NULL END)`,
    [id, `${id}@example.test`, subject, status, role],
  );
  fixtureIds.push(id);
  await owner.query(
    "INSERT INTO app.accounts (user_id,type,provider,provider_account_id) VALUES ($1,'oidc','google',$2)",
    [id, subject],
  );
  await owner.query("INSERT INTO app.sessions (session_token,user_id,expires) VALUES ($1,$2,$3)",
    [token, id, new Date(Date.now() + (expired ? -60_000 : 3_600_000))]);
  return { id, token };
}

function request(path: string, fixture?: Fixture, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  if (fixture) headers.set("cookie", `authjs.session-token=${fixture.token}`);
  return fetch(`${baseUrl}${path}`, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(10_000) });
}

async function expectRedirect(path: string, destination: string, fixture?: Fixture) {
  const response = await request(path, fixture);
  expect(response.status).toBe(307);
  expect(new URL(response.headers.get("location")!, baseUrl).pathname).toBe(destination);
  const body = await response.text();
  expect(body).not.toContain("Your administrator access is active.");
  expect(body).not.toContain("<h1>GIS Viewer</h1>");
}

beforeAll(async () => {
  const databaseName = process.env.PORTAL_INTEGRATION_DATABASE;
  if (!databaseName || !/^portal_test_[a-f0-9]{32}$/.test(databaseName)) {
    throw new Error("Run npm run test:integration to provision an isolated test database.");
  }
  owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
  const { rows: [database] } = await owner.query<{ name: string }>("SELECT current_database() AS name");
  if (database.name !== databaseName) throw new Error("Integration database isolation check failed.");
  const entry = resolve(".next/standalone/server.js");
  if (!existsSync(entry)) throw new Error("Run npm run build before the HTTP integration tests.");
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate HTTP test port.");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => listener.close((error) => error ? reject(error) : resolveClose()));
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      AUTH_URL: baseUrl,
      AUTH_SECRET: randomBytes(32).toString("hex"),
      GOOGLE_CLIENT_ID: "integration-test-client",
      GOOGLE_CLIENT_SECRET: "integration-test-secret",
      SUPER_ADMIN_EMAILS: "",
    },
    // Tests report assertions; server logs could contain session identifiers.
    stdio: "ignore",
  });
  let startError: Error | undefined;
  server.on("error", (error) => { startError = error; });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (startError || server.exitCode !== null) throw new Error("HTTP test server failed to start.");
    try {
      const response = await request("/login");
      if (response.status === 200) return;
    } catch { /* Wait for the test process to listen. */ }
    await delay(100);
  }
  throw new Error("HTTP test server did not become ready.");
}, 30_000);

afterAll(async () => {
  if (server?.pid && server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill("SIGTERM");
    const timeout = setTimeout(() => server.kill("SIGKILL"), 5_000);
    await exited;
    clearTimeout(timeout);
  }
  if (owner) {
    if (fixtureIds.length) {
      await owner.query("DELETE FROM app.audit_logs WHERE user_id = ANY($1::uuid[])", [fixtureIds]);
      await owner.query("DELETE FROM app.users WHERE id = ANY($1::uuid[])", [fixtureIds]);
    }
    await owner.end();
  }
});

describe("production HTTP route authorization", () => {
  it.each(["/", "/pending", "/access-denied", "/map", "/admin", "/admin/users"])("requires a session at %s", async (path) => {
    await expectRedirect(path, "/login");
  });

  it.each([
    ["PENDING", "VIEWER", "/pending"],
    ["PENDING", "ADMIN", "/pending"],
    ["REJECTED", "VIEWER", "/access-denied"],
    ["REJECTED", "ADMIN", "/access-denied"],
  ] as const)("restricts %s / %s to its status page", async (status, role, landing) => {
    const fixture = await createFixture(status, role);
    for (const path of ["/login", "/map", "/admin", "/admin/users"]) await expectRedirect(path, landing, fixture);
    const response = await request(landing, fixture);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(status === "PENDING"
      ? "Your account is waiting for administrator approval."
      : "Your access was not approved.");
  });

  it("allows an approved viewer at map while blocking a direct admin URL", async () => {
    const fixture = await createFixture("APPROVED", "VIEWER");
    await expectRedirect("/login", "/map", fixture);
    const response = await request("/map", fixture);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.text();
    expect(body).toContain("GIS Viewer");
    expect(body).not.toContain('href="/admin"');
    await expectRedirect("/admin", "/access-denied", fixture);
    await expectRedirect("/admin/users", "/access-denied", fixture);
  });

  it("allows an approved administrator at both protected pages", async () => {
    const fixture = await createFixture("APPROVED", "ADMIN");
    await expectRedirect("/login", "/map", fixture);
    for (const path of ["/map", "/admin", "/admin/users"]) expect((await request(path, fixture)).status).toBe(200);
    expect(await (await request("/admin", fixture)).text()).toContain("Your administrator access is active.");
  });

  it("applies approval, demotion, and rejection to the same existing session", async () => {
    const fixture = await createFixture("PENDING", "VIEWER");
    await expectRedirect("/map", "/pending", fixture);
    await owner.query("UPDATE app.users SET status='APPROVED',role='ADMIN',approved_at=now() WHERE id=$1", [fixture.id]);
    expect((await request("/admin", fixture)).status).toBe(200);
    await owner.query("UPDATE app.users SET role='VIEWER' WHERE id=$1", [fixture.id]);
    await expectRedirect("/admin", "/access-denied", fixture);
    await expectRedirect("/admin/users", "/access-denied", fixture);
    expect((await request("/map", fixture)).status).toBe(200);
    await owner.query("UPDATE app.users SET status='REJECTED',approved_at=NULL,approved_by=NULL WHERE id=$1", [fixture.id]);
    await expectRedirect("/map", "/access-denied", fixture);
  });

  it("rejects expired, forged, and incomplete-identity sessions", async () => {
    const expired = await createFixture("APPROVED", "ADMIN", true);
    await expectRedirect("/admin", "/login", expired);
    expect((await owner.query("SELECT 1 FROM app.sessions WHERE session_token=$1", [expired.token])).rowCount).toBe(0);
    await expectRedirect("/admin", "/login", { id: randomUUID(), token: randomBytes(32).toString("hex") });
    const incomplete = await createFixture("APPROVED", "ADMIN");
    await owner.query("DELETE FROM app.accounts WHERE user_id=$1", [incomplete.id]);
    await expectRedirect("/admin", "/login", incomplete);
  });

  it("exposes only public session fields and current database authorization", async () => {
    const fixture = await createFixture("APPROVED", "VIEWER");
    const response = await request("/api/auth/session", fixture);
    expect(response.status).toBe(200);
    const session = await response.json();
    expect(Object.keys(session).sort()).toEqual(["expires", "user"]);
    expect(Object.keys(session.user).sort()).toEqual(["email", "id", "image", "name", "role", "status"]);
    expect(session.user).toMatchObject({ id: fixture.id, role: "VIEWER", status: "APPROVED" });
    expect(JSON.stringify(session).includes(fixture.token)).toBe(false);
  });

  it("rejects a cross-origin logout and revokes the session on the real logout action", async () => {
    const fixture = await createFixture("APPROVED", "VIEWER");
    const html = await (await request("/map", fixture)).text();
    const action = html.match(/name="(\$ACTION_ID_[^"]+)"/);
    expect(action).not.toBeNull();
    const form = new FormData();
    form.set(action![1], "");
    const denied = await request("/map", fixture, { method: "POST", headers: { origin: "https://attacker.example" }, body: form });
    expect(denied.status).toBe(500);
    expect((await owner.query("SELECT 1 FROM app.sessions WHERE session_token=$1", [fixture.token])).rowCount).toBe(1);
    const loggedOut = await request("/map", fixture, { method: "POST", headers: { origin: baseUrl }, body: form });
    expect(loggedOut.status).toBe(303);
    expect(new URL(loggedOut.headers.get("location")!, baseUrl).pathname).toBe("/login");
    expect((await owner.query("SELECT 1 FROM app.sessions WHERE session_token=$1", [fixture.token])).rowCount).toBe(0);
    await expectRedirect("/map", "/login", fixture);
  });

  it("approves a pending account from the admin form as VIEWER and records the authenticated actor", async () => {
    const admin = await createFixture("APPROVED", "ADMIN");
    const pending = await createFixture("PENDING", "VIEWER");
    const html = await (await request("/admin", admin)).text();
    expect(html).toContain(`${pending.id}@example.test`);
    const formHtml = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)]
      .map(([form]) => form).find((form) => form.includes(`data-user-id="${pending.id}"`));
    expect(formHtml).toBeDefined();
    const action = formHtml!.match(/name="(\$ACTION_ID_[^"]+)"/);
    expect(action).not.toBeNull();
    const form = new FormData();
    form.set(action![1], "");
    form.set("userId", pending.id);
    form.set("page", "1");
    // Client-supplied role and actor must never influence the approval.
    form.set("role", "ADMIN");
    form.set("approvedBy", pending.id);
    const response = await request("/admin", admin, { method: "POST", headers: { origin: baseUrl }, body: form });
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get("location")!, baseUrl).searchParams.get("result")).toBe("approved");
    const { rows: [updated] } = await owner.query("SELECT status,role,approved_by,approved_at FROM app.users WHERE id=$1", [pending.id]);
    expect(updated).toMatchObject({ status: "APPROVED", role: "VIEWER", approved_by: admin.id });
    expect(updated.approved_at).toBeInstanceOf(Date);
    const { rows: [audit] } = await owner.query("SELECT user_id,action FROM app.audit_logs WHERE target_id=$1", [pending.id]);
    expect(audit).toEqual({ user_id: admin.id, action: "USER_APPROVED" });
    expect((await request("/map", pending)).status).toBe(200);
    await expectRedirect("/admin", "/access-denied", pending);
    expect(await (await request("/admin", admin)).text()).not.toContain(`data-user-id="${pending.id}"`);
  });

  it("blocks forged approval requests from viewers, anonymous users, and foreign origins", async () => {
    const admin = await createFixture("APPROVED", "ADMIN");
    const viewer = await createFixture("APPROVED", "VIEWER");
    const target = await createFixture("PENDING", "VIEWER");
    const html = await (await request("/admin", admin)).text();
    const formHtml = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)]
      .map(([form]) => form).find((form) => form.includes(`data-user-id="${target.id}"`));
    const action = formHtml?.match(/name="(\$ACTION_ID_[^"]+)"/);
    expect(action).toBeTruthy();
    const form = new FormData();
    form.set(action![1], "");
    form.set("userId", target.id);
    for (const [actor, destination] of [[viewer, "/access-denied"], [undefined, "/login"]] as const) {
      const response = await request("/admin", actor, { method: "POST", headers: { origin: baseUrl }, body: form });
      expect(response.status).toBe(303);
      expect(new URL(response.headers.get("location")!, baseUrl).pathname).toBe(destination);
    }
    const denied = await request("/admin", admin, {
      method: "POST", headers: { origin: "https://attacker.example" }, body: form,
    });
    expect(denied.status).toBe(500);
    // Even a previously authorized administrator loses mutation access after demotion.
    await owner.query("UPDATE app.users SET role='VIEWER' WHERE id=$1", [admin.id]);
    const demoted = await request("/admin", admin, { method: "POST", headers: { origin: baseUrl }, body: form });
    expect(demoted.status).toBe(303);
    expect(new URL(demoted.headers.get("location")!, baseUrl).pathname).toBe("/access-denied");
    const { rows: [untouched] } = await owner.query("SELECT status,role,approved_by FROM app.users WHERE id=$1", [target.id]);
    expect(untouched).toEqual({ status: "PENDING", role: "VIEWER", approved_by: null });
    expect((await owner.query("SELECT 1 FROM app.audit_logs WHERE target_id=$1", [target.id])).rowCount).toBe(0);
  });
});


describe("approved account and presence APIs", () => {
  function presence(fixture: Fixture | undefined, body: unknown, origin = baseUrl) {
    return request("/api/presence", fixture, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  it("restricts approved account details to approved administrators", async () => {
    expect((await request("/api/admin/users/approved")).status).toBe(401);
    for (const status of ["PENDING", "REJECTED", "APPROVED"] as const) {
      const viewer = await createFixture(status, "VIEWER");
      expect((await request("/api/admin/users/approved", viewer)).status).toBe(403);
    }
    const admin = await createFixture("APPROVED", "ADMIN");
    const response = await request("/api/admin/users/approved", admin);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const data = await response.json();
    expect(data.users.length).toBeGreaterThan(0);
    expect(Object.keys(data.users[0]).sort()).toEqual(["approvalSource", "approvedAt", "approvedBy", "email", "id", "name", "online"]);
    expect(JSON.stringify(data)).not.toContain(admin.token);
  });

  it("validates origin, session, status and strict heartbeat payloads", async () => {
    const viewer = await createFixture("APPROVED", "VIEWER");
    const payload = { tabId: randomUUID(), activity: "heartbeat" };
    expect((await presence(undefined, payload)).status).toBe(401);
    expect((await presence(viewer, payload, "https://attacker.example")).status).toBe(403);
    expect((await presence(viewer, { ...payload, userId: randomUUID() })).status).toBe(400);
    expect((await presence(viewer, { ...payload, tabId: "invalid" })).status).toBe(400);
    expect((await presence(viewer, { ...payload, extra: "x".repeat(1100) })).status).toBe(400);
    expect((await request("/api/presence", viewer, { method: "POST", headers: { origin: baseUrl, "content-type": "text/plain" }, body: "test" })).status).toBe(415);
    for (const status of ["PENDING", "REJECTED"] as const) {
      expect((await presence(await createFixture(status, "VIEWER"), payload)).status).toBe(403);
    }
    expect((await presence(await createFixture("APPROVED", "VIEWER", true), payload)).status).toBe(401);
    expect((await presence(viewer, payload)).status).toBe(204);
    const rows = await owner.query("SELECT session_token,tab_id FROM app.user_presence WHERE session_token=$1", [viewer.token]);
    expect(rows.rows).toEqual([{ session_token: viewer.token, tab_id: payload.tabId }]);
  });

  it("updates online status without letting one tab remove another", async () => {
    const admin = await createFixture("APPROVED", "ADMIN");
    const viewer = await createFixture("APPROVED", "VIEWER");
    await owner.query("UPDATE app.users SET approved_at=now()+interval '1 day',approved_by=$2 WHERE id=$1", [viewer.id, admin.id]);
    const first = randomUUID();
    const second = randomUUID();
    async function account() {
      const data = await (await request("/api/admin/users/approved", admin)).json();
      return data.users.find((user: { id: string }) => user.id === viewer.id);
    }
    expect((await account()).online).toBe(false);
    expect((await presence(viewer, { tabId: first, activity: "heartbeat" })).status).toBe(204);
    expect((await presence(viewer, { tabId: second, activity: "heartbeat" })).status).toBe(204);
    expect(await account()).toMatchObject({ online: true, approvedBy: { name: "HTTP test user", email: `${admin.id}@example.test` }, approvalSource: "administrator" });
    await presence(viewer, { tabId: first, activity: "leave" });
    expect((await account()).online).toBe(true);
    await presence(viewer, { tabId: second, activity: "leave" });
    expect((await account()).online).toBe(false);
    await presence(viewer, { tabId: second, activity: "heartbeat" });
    await owner.query("UPDATE app.user_presence SET last_seen=now()-interval '61 seconds' WHERE session_token=$1", [viewer.token]);
    expect((await account()).online).toBe(false);
    await owner.query("DELETE FROM app.sessions WHERE session_token=$1", [viewer.token]);
    expect((await owner.query("SELECT 1 FROM app.user_presence WHERE session_token=$1", [viewer.token])).rowCount).toBe(0);
  });
});


describe("GIS viewer data authorization", () => {
  const layerId = "abcdef01-2345-4234-8234-0123456789ab";
  const tableName = "layer_abcdef012345423482340123456789ab";
  const tilePath = `/api/layers/${layerId}/tiles/12/2048/2048.pbf`;
  beforeAll(async () => {
    const actor = await createFixture("APPROVED", "ADMIN");
    // Isolated automated-test fixture only; never seeded by application migrations.
    await owner.query(`CREATE TABLE gis.${tableName}(feature_id integer PRIMARY KEY, properties jsonb NOT NULL, geom geometry(Point,4326) NOT NULL)`);
    await owner.query(`INSERT INTO gis.${tableName} VALUES(1,'{"name":"Integration point"}',ST_SetSRID(ST_MakePoint(0,0),4326))`);
    await owner.query(`GRANT SELECT ON gis.${tableName} TO gis_app`);
    await owner.query(`INSERT INTO app.layers(id,name,layer_type,source_type,table_name,uploaded_by,srid,state,geometry_type,feature_count,bbox,style_json)
      VALUES($1,'Integration layer','VECTOR','POSTGIS',$2,$3,4326,'READY','Point',1,ST_MakeEnvelope(-1,-1,1,1,4326),'{"color":"#4361ee","opacity":1,"width":3,"radius":7}')`,[layerId,tableName,actor.id]);
  });
  afterAll(async()=>{
    await owner.query("DELETE FROM app.layers WHERE id=$1",[layerId]);
    await owner.query(`DROP TABLE IF EXISTS gis.${tableName}`);
  });
  it("rejects every GIS endpoint for anonymous, pending and rejected accounts", async()=>{
    for(const path of ["/api/layers",`/api/layers/${layerId}`,tilePath,"/api/basemaps"]) {
      expect((await request(path)).status).toBe(401);
      for(const status of ["PENDING","REJECTED"] as const) {
        expect((await request(path,await createFixture(status,"ADMIN"))).status).toBe(403);
      }
    }
  });
  it("serves a safe catalog and real vector tiles to approved viewers", async()=>{
    const viewer=await createFixture("APPROVED","VIEWER");
    const response=await request("/api/layers",viewer);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const {layers}=await response.json();
    expect(layers).toHaveLength(1);
    for(const layer of layers) {
      expect(layer).not.toHaveProperty("demo");
      expect(layer.bounds).toHaveLength(4);
      expect(layer).not.toHaveProperty("tableName");expect(layer).not.toHaveProperty("filePath");expect(layer).not.toHaveProperty("storageMetadata");
    }
    const lon=0,lat=0,z=12;
    const x=Math.floor((lon+180)/360*2**z);
    const y=Math.floor((1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2*2**z);
    const tile=await request(`/api/layers/${layerId}/tiles/${z}/${x}/${y}.pbf`,viewer);
    expect(tile.status).toBe(200);expect(tile.headers.get("content-type")).toContain("vector-tile");
    const decoded=new VectorTile(new PbfReader(await tile.arrayBuffer()));
    expect(decoded.layers.features.length).toBeGreaterThan(0);
    expect(decoded.layers.features.feature(0).properties).toHaveProperty("name");
    expect((await request("/api/basemaps",viewer)).status).toBe(200);
  });
  it("enforces global visibility and READY state on direct metadata and tile requests", async()=>{
    const viewer=await createFixture("APPROVED","VIEWER");
    const admin=await createFixture("APPROVED","ADMIN");
    try {
      await owner.query("UPDATE app.layers SET is_visible=false WHERE id=$1",[layerId]);
      expect((await (await request("/api/layers",viewer)).json()).layers).toHaveLength(0);
      for(const path of [`/api/layers/${layerId}`,tilePath]) expect((await request(path,viewer)).status).toBe(404);
      expect((await request(`/api/layers/${layerId}`,admin)).status).toBe(200);
      await owner.query("UPDATE app.layers SET state='FAILED' WHERE id=$1",[layerId]);
      for(const actor of [viewer,admin]) expect((await request(tilePath,actor)).status).toBe(404);
    } finally {await owner.query("UPDATE app.layers SET state='READY',is_visible=true WHERE id=$1",[layerId]);}
  });
  it("validates ids and tile ranges and rechecks revoked access", async()=>{
    const viewer=await createFixture("APPROVED","VIEWER");
    expect((await request("/api/layers/not-a-uuid",viewer)).status).toBe(404);
    for(const path of ["23/0/0.pbf","2/4/0.pbf","2/0/4.pbf","-1/0/0.pbf","1/abc/0.pbf"]) {
      expect((await request(`/api/layers/${layerId}/tiles/${path}`,viewer)).status).toBe(400);
    }
    await owner.query("UPDATE app.users SET status='REJECTED',approved_at=NULL WHERE id=$1",[viewer.id]);
    expect((await request(tilePath,viewer)).status).toBe(403);
  });
  it("keeps runtime database access read-only for layer metadata and geometry", async()=>{
    const runtime=new Pool({connectionString:process.env.DATABASE_URL});
    try {
      await expect(runtime.query("DELETE FROM app.layers WHERE id=$1",[layerId])).rejects.toMatchObject({code:"42501"});
      await expect(runtime.query(`DELETE FROM gis.${tableName}`)).rejects.toMatchObject({code:"42501"});
      await expect(runtime.query("CREATE TABLE gis.forbidden(id integer)")).rejects.toMatchObject({code:"42501"});
    } finally {await runtime.end();}
  });
});

describe("user management production server actions",()=>{
  async function formFor(admin: Fixture, target: Fixture, operation: string) {
    const html=await(await request(`/admin/users?q=${target.id}`,admin)).text();
    const formHtml=[...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map(([form])=>form)
      .find(form=>form.includes(`data-user-id="${target.id}"`) && form.includes(`data-operation="${operation}"`));
    expect(formHtml).toBeDefined();
    const form=new FormData();
    const action=formHtml!.match(/name="(\$ACTION_ID_[^"]+)"/);
    expect(action).toBeTruthy();
    form.set(action![1],"");
    for(const [,key,value] of formHtml!.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)) form.set(key,value.replaceAll("&amp;","&"));
    return form;
  }
  function post(actor: Fixture|undefined, form: FormData, origin=baseUrl) {
    return request("/admin/users",actor,{method:"POST",headers:{origin},body:form});
  }
  function result(response: Response) { return new URL(response.headers.get("location")!,baseUrl).searchParams.get("result"); }
  it("allows approve, role change and reject through forms, with fresh-session enforcement",async()=>{
    const admin=await createFixture("APPROVED","ADMIN"),target=await createFixture("PENDING","VIEWER");
    const approve=await formFor(admin,target,"approve");
    approve.set("approvedBy",target.id);approve.set("role","ADMIN");
    expect(result(await post(admin,approve))).toBe("approved");
    expect((await owner.query("SELECT role,approved_by FROM app.users WHERE id=$1",[target.id])).rows[0]).toEqual({role:"VIEWER",approved_by:admin.id});
    expect((await request("/map",target)).status).toBe(200);
    const promote=await formFor(admin,target,"role");promote.set("role","ADMIN");
    expect(result(await post(admin,promote))).toBe("role");
    expect((await request("/admin/users",target)).status).toBe(200);
    const demote=await formFor(admin,target,"role");demote.set("role","VIEWER");
    expect(result(await post(admin,demote))).toBe("role");
    await expectRedirect("/admin/users","/access-denied",target);
    expect(result(await post(admin,await formFor(admin,target,"reject")))).toBe("rejected");
    await expectRedirect("/map","/login",target);
    expect((await owner.query("SELECT status,approved_by,approved_at FROM app.users WHERE id=$1",[target.id])).rows[0]).toEqual({status:"REJECTED",approved_by:null,approved_at:null});
  });
  it("blocks every mutation from anonymous, viewer, pending, rejected and newly demoted accounts",async()=>{
    const admin=await createFixture("APPROVED","ADMIN"),target=await createFixture("PENDING","VIEWER");
    const viewer=await createFixture("APPROVED","VIEWER"),pending=await createFixture("PENDING","ADMIN"),rejected=await createFixture("REJECTED","ADMIN");
    for(const operation of ["approve","reject","role"]){
      const form=await formFor(admin,target,operation);if(operation==="role")form.set("role","ADMIN");
      for(const [actor,path] of [[undefined,"/login"],[viewer,"/access-denied"],[pending,"/pending"],[rejected,"/access-denied"]] as const){
        const response=await post(actor,form);expect(response.status).toBe(303);
        expect(new URL(response.headers.get("location")!,baseUrl).pathname).toBe(path);
      }
      expect((await post(admin,form,"https://attacker.example")).status).toBe(500);
    }
    const form=await formFor(admin,target,"approve");
    await owner.query("UPDATE app.users SET role='VIEWER' WHERE id=$1",[admin.id]);
    expect(new URL((await post(admin,form)).headers.get("location")!,baseUrl).pathname).toBe("/access-denied");
    expect((await owner.query("SELECT status,role FROM app.users WHERE id=$1",[target.id])).rows[0]).toEqual({status:"PENDING",role:"VIEWER"});
  });
  it("returns safe errors for invalid roles, duplicate parameters, missing users and stale versions",async()=>{
    const admin=await createFixture("APPROVED","ADMIN"),target=await createFixture("PENDING","VIEWER");
    const form=await formFor(admin,target,"role");form.set("role","OWNER");
    expect(result(await post(admin,form))).toBe("invalid");
    form.set("role","ADMIN");form.append("userId",admin.id);
    expect(result(await post(admin,form))).toBe("invalid");
    form.set("userId",randomUUID());expect(result(await post(admin,form))).toBe("missing");
    form.set("userId",target.id);form.set("version","stale");expect(result(await post(admin,form))).toBe("conflict");
    const html=await(await request("/admin/users?result=failed",admin)).text();
    expect(html).toContain("The change could not be saved.");
    expect(html).not.toContain("postgresql://");
  });
});
