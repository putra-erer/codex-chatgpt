import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Account, NextAuthConfig } from "next-auth";
import type { Adapter, AdapterSession, AdapterUser } from "next-auth/adapters";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
// Exercise the installed Auth.js lifecycle, including its emailVerified=null behavior.
// These internal imports deliberately make incompatible dependency updates fail tests.
import { handleLoginOrRegister } from "../../node_modules/@auth/core/lib/actions/callback/handle-login.js";
import { createAuthConfig } from "@/auth";
import { getDb, getPool } from "@/server/db";
import { accounts, auditLogs, sessions, users, type UserRole, type UserStatus } from "@/server/db/schema";
import { canAccessAdmin, canAccessMap, landingPath } from "@/server/authorization/policy";

type Profile = { sub: string; email: string; email_verified: boolean; name: string };
type Login = { user: AdapterUser; session: AdapterSession; adapter: Adapter; isNewUser: boolean };
type CoreOptions = Parameters<typeof handleLoginOrRegister>[3];
const administratorEmail = "admin@integration.example";
let owner: Pool;

function profile(email = `${randomUUID()}@integration.example`): Profile {
  return { sub: randomUUID(), email, email_verified: true, name: "Integration user" };
}

function account(identity: Profile): Account & { type: "oidc" } {
  return {
    provider: "google", providerAccountId: identity.sub, type: "oidc",
    access_token: "test-access-token", refresh_token: "test-refresh-token", id_token: "test-id-token",
  };
}

async function authorize(config: NextAuthConfig, identity: Profile) {
  return config.callbacks!.signIn!({
    user: { id: identity.sub, email: identity.email, name: identity.name },
    account: account(identity), profile: identity,
  });
}

async function login(identity: Profile, config = createAuthConfig()): Promise<Login> {
  if (await authorize(config, identity) !== true) throw new Error("Test identity was rejected before account creation.");
  // The surrounding OAuth exchange has already verified the profile in production.
  // Only that exchange is replaced with local fixtures; persistence uses real Auth.js.
  const options = {
    ...config,
    session: { ...config.session, generateSessionToken: randomUUID },
    provider: { id: "google", type: "oidc", allowDangerousEmailAccountLinking: false, account: (tokens: object) => tokens },
    events: config.events ?? {},
  } as CoreOptions;
  const result = await handleLoginOrRegister("", {
    id: identity.sub, email: identity.email.trim().toLowerCase(), name: identity.name, emailVerified: new Date(),
  }, account(identity), options);
  if (!result.session || typeof result.session.sessionToken !== "string") throw new Error("Expected a persisted database session.");
  const session = result.session as AdapterSession;
  const stored = await config.adapter!.getSessionAndUser!(session.sessionToken);
  if (!stored) throw new Error("Created session cannot be resolved.");
  await config.events?.signIn?.({ user: stored.user, account: account(identity), isNewUser: result.isNewUser });
  return { ...stored, adapter: config.adapter!, isNewUser: Boolean(result.isNewUser) };
}

async function setAccess(id: string, status: UserStatus, role: UserRole) {
  await owner.query(
    `UPDATE app.users SET status=$1::app.user_status,role=$2::app.user_role,approved_by=NULL,
     approved_at=CASE WHEN $1::app.user_status='APPROVED' THEN now() ELSE NULL END WHERE id=$3`, [status, role, id],
  );
}

async function devUser(args: string[], env: Partial<NodeJS.ProcessEnv> = {}) {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/dev-user.ts", ...args], {
    env: { ...process.env, ALLOW_DEV_USER_COMMAND: "true", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data: Buffer) => { output += data.toString(); });
  child.stderr.on("data", (data: Buffer) => { output += data.toString(); });
  const code = await new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("exit", done);
  });
  return { code, output };
}

function changeUser(email: string, status: UserStatus, role: UserRole, actor = administratorEmail) {
  return ["--email", email, "--status", status, "--role", role, "--approved-by", actor];
}

beforeAll(async () => {
  const name = process.env.PORTAL_INTEGRATION_DATABASE;
  if (!name || !/^portal_test_[a-f0-9]{32}$/.test(name)) {
    throw new Error("Run npm run test:integration to provision an isolated test database.");
  }
  owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
  for (const pool of [owner, getPool()]) {
    const { rows: [database] } = await pool.query<{ name: string }>("SELECT current_database() AS name");
    if (database.name !== name) throw new Error("Integration database isolation check failed.");
  }
});

beforeEach(async () => {
  await owner.query("TRUNCATE app.audit_logs,app.sessions,app.accounts,app.users CASCADE");
});

afterAll(async () => {
  await Promise.all([owner?.end(), getPool().end()]);
});

describe("real PostgreSQL and Auth.js account lifecycle", () => {
  it("applies all migrations once and enables PostGIS", async () => {
    const { rows: [extension] } = await getPool().query<{ version: string }>("SELECT postgis_lib_version() AS version");
    expect(extension.version).toMatch(/^3\./);
    const { rows: [migrations] } = await owner.query<{ count: string }>("SELECT count(*) FROM drizzle.__drizzle_migrations");
    expect(Number(migrations.count)).toBe(4);
  });

  it("creates a verified PENDING VIEWER with account and session through the actual Auth.js lifecycle", async () => {
    const identity = profile("  New.User@integration.example  ");
    const result = await login(identity);
    expect(result.isNewUser).toBe(true);
    expect(result.user).toMatchObject({ email: "new.user@integration.example", status: "PENDING", role: "VIEWER" });
    const [stored] = await getDb().select().from(users).where(eq(users.id, result.user.id));
    expect(stored.emailVerified).toBeInstanceOf(Date);
    expect(stored.googleId).toBe(identity.sub);
    expect(stored.approvedAt).toBeNull();
    expect(landingPath(stored)).toBe("/pending");
    expect(canAccessMap(stored)).toBe(false);
    expect(canAccessAdmin(stored)).toBe(false);
    expect(result.session.expires.getTime()).toBeGreaterThan(Date.now());
    expect((await getDb().select().from(auditLogs)).map((entry) => entry.action)).toEqual(["LOGIN"]);
  });

  it("discards Google access, refresh, and ID tokens when linking an account", async () => {
    await login(profile());
    const [linked] = await getDb().select().from(accounts);
    expect(linked).toMatchObject({ provider: "google", access_token: null, refresh_token: null, id_token: null });
  });

  it.each([
    ["PENDING", "VIEWER", "/pending"],
    ["APPROVED", "VIEWER", "/map"],
    ["APPROVED", "ADMIN", "/map"],
    ["REJECTED", "VIEWER", "/access-denied"],
  ] as const)("preserves %s / %s on repeat Google login", async (status, role, path) => {
    const identity = profile();
    const first = await login(identity);
    await setAccess(first.user.id, status, role);
    const repeated = await login({ ...identity, name: "Updated profile name" });
    expect(repeated.isNewUser).toBe(false);
    expect(repeated.user).toMatchObject({ id: first.user.id, name: "Updated profile name", status, role });
    expect(landingPath(repeated.user)).toBe(path);
    expect((await getDb().select().from(users))).toHaveLength(1);
    expect((await getDb().select().from(accounts))).toHaveLength(1);
    expect(repeated.session.sessionToken).not.toBe(first.session.sessionToken);
  });

  it("bootstraps the exact configured verified email as APPROVED ADMIN with one set of audit entries", async () => {
    const identity = profile(administratorEmail.toUpperCase());
    const result = await login(identity);
    expect(result.user).toMatchObject({ email: administratorEmail, status: "APPROVED", role: "ADMIN" });
    expect(canAccessAdmin(result.user)).toBe(true);
    const [stored] = await getDb().select().from(users);
    expect(stored.approvedAt).toBeInstanceOf(Date);
    await login(identity);
    const actions = (await getDb().select().from(auditLogs)).map((entry) => entry.action);
    expect(actions.filter((action) => action === "USER_APPROVED")).toHaveLength(1);
    expect(actions.filter((action) => action === "ROLE_CHANGED")).toHaveLength(1);
    expect(actions.filter((action) => action === "LOGIN")).toHaveLength(2);
  });

  it("does not bootstrap a similar email and cannot create an unverified bootstrap user", async () => {
    const similar = await login(profile(`prefix-${administratorEmail}`));
    expect(similar.user).toMatchObject({ role: "VIEWER", status: "PENDING" });
    const config = createAuthConfig();
    const unverified = { ...profile(administratorEmail), email_verified: false };
    expect(await authorize(config, unverified)).toBe(false);
    await expect(config.adapter!.createUser!({ id: unverified.sub, email: unverified.email,
      emailVerified: new Date(), role: "ADMIN", status: "APPROVED" })).rejects.toThrow("verified Google email");
    expect((await getDb().select().from(users))).toHaveLength(1);
  });

  it("rejects an email collision or partially linked identity without silently merging users", async () => {
    const identity = profile();
    const first = await login(identity);
    expect(await authorize(createAuthConfig(), { ...identity, sub: randomUUID() })).toBe(false);
    await owner.query("DELETE FROM app.accounts WHERE user_id=$1", [first.user.id]);
    expect(await authorize(createAuthConfig(), identity)).toBe(false);
    expect((await getDb().select().from(users))).toHaveLength(1);
    expect((await getDb().select().from(accounts))).toHaveLength(0);
    expect(await first.adapter.getSessionAndUser!(first.session.sessionToken)).toBeNull();
  });

  it("rejects a provider/profile subject mismatch before account creation", async () => {
    const identity = profile();
    const config = createAuthConfig();
    expect(await config.callbacks!.signIn!({ user: { email: identity.email }, profile: identity,
      account: { ...account(identity), providerAccountId: "different-subject" } })).toBe(false);
    expect((await getDb().select().from(users))).toHaveLength(0);
  });

  it("cannot mint a session from another request's verified identity or from a partially linked user", async () => {
    const identity = profile();
    const first = await login(identity);
    const session = { userId: first.user.id, sessionToken: randomUUID(), expires: new Date(Date.now() + 60_000) };
    const otherRequest = createAuthConfig();
    await expect(otherRequest.adapter!.createSession!(session)).rejects.toThrow("verified Google profile");
    await owner.query("DELETE FROM app.accounts WHERE user_id=$1", [first.user.id]);
    await expect(first.adapter.createSession!(session)).rejects.toThrow("linkage is complete");
    expect((await getDb().select().from(sessions))).toHaveLength(1);
  });

  it("rolls back account linkage when bootstrap fails", async () => {
    const config = createAuthConfig();
    const identity = profile(administratorEmail);
    expect(await authorize(config, identity)).toBe(true);
    const created = await config.adapter!.createUser!({ id: identity.sub, email: identity.email,
      emailVerified: null, role: "VIEWER", status: "PENDING" });
    // Force the audit write to fail after linking, proving the entire transaction rolls back.
    await owner.query("ALTER TABLE app.audit_logs ADD CONSTRAINT test_reject_audit CHECK (false)");
    try {
      await expect(config.adapter!.linkAccount!({ ...account(identity), userId: created.id })).rejects.toThrow();
      const [stored] = await getDb().select().from(users).where(eq(users.id, created.id));
      expect(stored).toMatchObject({ googleId: null, role: "VIEWER", status: "PENDING" });
      expect((await getDb().select().from(accounts))).toHaveLength(0);
    } finally {
      await owner.query("ALTER TABLE app.audit_logs DROP CONSTRAINT test_reject_audit");
    }
  });

  it("prevents adapter profile updates from changing authorization or replacing the email", async () => {
    const result = await login(profile());
    await result.adapter.updateUser!({ id: result.user.id, name: "Updated name", role: "ADMIN", status: "APPROVED" });
    const [stored] = await getDb().select().from(users);
    expect(stored).toMatchObject({ name: "Updated name", role: "VIEWER", status: "PENDING" });
    await expect(result.adapter.updateUser!({ id: result.user.id, email: "another@integration.example" })).rejects.toThrow("Invalid adapter user update");
  });
});

describe("database constraints and runtime privileges", () => {
  it("uses a non-superuser runtime role without schema creation privileges", async () => {
    const { rows: [role] } = await getPool().query(
      "SELECT current_user AS name,rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user",
    );
    expect(role).toMatchObject({ name: "gis_app", rolsuper: false, rolcreatedb: false, rolcreaterole: false });
    await expect(getPool().query("CREATE TABLE public.forbidden_table(id integer)")).rejects.toMatchObject({ code: "42501" });
    await expect(getPool().query("CREATE TABLE app.forbidden_table(id integer)")).rejects.toMatchObject({ code: "42501" });
    await expect(getPool().query("SELECT * FROM drizzle.__drizzle_migrations")).rejects.toMatchObject({ code: "42501" });
  });

  it("lets the runtime role append audit entries but prevents their modification or deletion", async () => {
    await login(profile());
    expect((await getDb().select().from(auditLogs))).toHaveLength(1);
    await expect(getPool().query("UPDATE app.audit_logs SET action='LOGIN'")).rejects.toMatchObject({ code: "42501" });
    await expect(getPool().query("DELETE FROM app.audit_logs")).rejects.toMatchObject({ code: "42501" });
  });

  it("enforces normalized unique emails, verified approval, allowed roles and Google-only accounts", async () => {
    const result = await login(profile());
    await expect(getPool().query("INSERT INTO app.users(email) VALUES ('Mixed@integration.example')")).rejects.toMatchObject({ code: "23514" });
    await expect(getPool().query("INSERT INTO app.users(email) VALUES ($1)", [result.user.email])).rejects.toMatchObject({ code: "23505" });
    await expect(getPool().query("INSERT INTO app.users(email,status,approved_at) VALUES ('incomplete@integration.example','APPROVED',now())")).rejects.toMatchObject({ code: "23514" });
    await expect(getPool().query("UPDATE app.users SET role='OWNER' WHERE id=$1", [result.user.id])).rejects.toMatchObject({ code: "22P02" });
    await expect(getPool().query("INSERT INTO app.accounts(user_id,type,provider,provider_account_id) VALUES ($1,'oauth','github','other')", [result.user.id])).rejects.toMatchObject({ code: "23514" });
  });
});

describe("development user administration against PostgreSQL", () => {
  it("approves and promotes existing users, then rejects them, revokes sessions, and records changes", async () => {
    const admin = await login(profile(administratorEmail));
    const identity = profile();
    const pending = await login(identity);
    const approved = await devUser(changeUser(identity.email, "APPROVED", "VIEWER"));
    expect(approved.code).toBe(0);
    const live = await pending.adapter.getSessionAndUser!(pending.session.sessionToken);
    expect(live?.user).toMatchObject({ status: "APPROVED", role: "VIEWER" });
    expect(canAccessMap(live?.user)).toBe(true);
    expect(canAccessAdmin(live?.user)).toBe(false);
    expect((await devUser(changeUser(identity.email, "APPROVED", "ADMIN"))).code).toBe(0);
    expect((await pending.adapter.getSessionAndUser!(pending.session.sessionToken))?.user.role).toBe("ADMIN");
    expect((await devUser(changeUser(identity.email, "REJECTED", "VIEWER"))).code).toBe(0);
    expect(await pending.adapter.getSessionAndUser!(pending.session.sessionToken)).toBeNull();
    const relogin = await login(identity);
    expect(landingPath(relogin.user)).toBe("/access-denied");
    const mutations = await getDb().select().from(auditLogs).where(eq(auditLogs.userId, admin.user.id));
    expect(mutations.filter((entry) => entry.targetId === pending.user.id).map((entry) => entry.action).sort())
      .toEqual(["ROLE_CHANGED", "ROLE_CHANGED", "USER_APPROVED", "USER_REJECTED"]);
  });

  it("blocks removing the last administrator, bootstrap demotion, and unapproved actors", async () => {
    const admin = await login(profile(administratorEmail));
    const pendingProfile = profile();
    await login(pendingProfile);
    const bootstrap = await devUser(changeUser(administratorEmail, "REJECTED", "VIEWER"));
    expect(bootstrap.code).toBe(1);
    expect(bootstrap.output).toContain("Remove this email from SUPER_ADMIN_EMAILS");
    const lastAdmin = await devUser(changeUser(administratorEmail, "REJECTED", "VIEWER"), { SUPER_ADMIN_EMAILS: "" });
    expect(lastAdmin.code).toBe(1);
    expect(lastAdmin.output).toContain("Cannot remove the last approved administrator");
    const badActor = await devUser(changeUser(pendingProfile.email, "APPROVED", "ADMIN", pendingProfile.email));
    expect(badActor.code).toBe(1);
    expect(badActor.output).toContain("existing approved administrator");
    expect((await admin.adapter.getSessionAndUser!(admin.session.sessionToken))?.user).toMatchObject({ role: "ADMIN", status: "APPROVED" });
  });

  it("never creates users and requires a completed Google identity", async () => {
    await login(profile(administratorEmail));
    const absent = await devUser(changeUser("absent@integration.example", "APPROVED", "ADMIN"));
    expect(absent.code).toBe(1);
    await owner.query("INSERT INTO app.users(email) VALUES ('partial@integration.example')");
    const partial = await devUser(changeUser("partial@integration.example", "APPROVED", "ADMIN"));
    expect(partial.code).toBe(1);
    expect(partial.output).toContain("must log in with verified Google first");
    expect((await getDb().select().from(users))).toHaveLength(2);
  });

  it.each([
    { ALLOW_DEV_USER_COMMAND: "false" },
    { NODE_ENV: "production" },
  ] as const)("requires the development opt-in and refuses production: %j", async (env) => {
    const result = await devUser(changeUser("absent@integration.example", "APPROVED", "ADMIN"), env);
    expect(result.code).toBe(1);
    expect(result.output).toContain("Development tool disabled");
    expect((await getDb().select().from(users))).toHaveLength(0);
  });
});
