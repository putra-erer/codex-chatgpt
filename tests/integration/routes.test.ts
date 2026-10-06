import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
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
  expect(body).not.toContain("A place for your spatial workspace.");
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
  it.each(["/", "/pending", "/access-denied", "/map", "/admin"])("requires a session at %s", async (path) => {
    await expectRedirect(path, "/login");
  });

  it.each([
    ["PENDING", "VIEWER", "/pending"],
    ["PENDING", "ADMIN", "/pending"],
    ["REJECTED", "VIEWER", "/access-denied"],
    ["REJECTED", "ADMIN", "/access-denied"],
  ] as const)("restricts %s / %s to its status page", async (status, role, landing) => {
    const fixture = await createFixture(status, role);
    for (const path of ["/login", "/map", "/admin"]) await expectRedirect(path, landing, fixture);
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
    expect(body).toContain("A place for your spatial workspace.");
    expect(body).not.toContain('href="/admin"');
    await expectRedirect("/admin", "/access-denied", fixture);
  });

  it("allows an approved administrator at both protected pages", async () => {
    const fixture = await createFixture("APPROVED", "ADMIN");
    await expectRedirect("/login", "/map", fixture);
    for (const path of ["/map", "/admin"]) expect((await request(path, fixture)).status).toBe(200);
    expect(await (await request("/admin", fixture)).text()).toContain("Your administrator access is active.");
  });

  it("applies approval, demotion, and rejection to the same existing session", async () => {
    const fixture = await createFixture("PENDING", "VIEWER");
    await expectRedirect("/map", "/pending", fixture);
    await owner.query("UPDATE app.users SET status='APPROVED',role='ADMIN',approved_at=now() WHERE id=$1", [fixture.id]);
    expect((await request("/admin", fixture)).status).toBe(200);
    await owner.query("UPDATE app.users SET role='VIEWER' WHERE id=$1", [fixture.id]);
    await expectRedirect("/admin", "/access-denied", fixture);
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
});
