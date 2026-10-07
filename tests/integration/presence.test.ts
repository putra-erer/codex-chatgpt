import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapAdmin } from "@/server/auth/service";
import { getDb, getPool } from "@/server/db";
import { users, type UserRole, type UserStatus } from "@/server/db/schema";
import { heartbeat, leave } from "@/server/presence/service";
import { listApprovedUsers } from "@/server/users/approved";

let owner: Pool;

type FixtureOptions = {
  status?: UserStatus;
  role?: UserRole;
  name?: string | null;
  linked?: boolean;
  matchingAccount?: boolean;
  approvedBy?: string;
  approvedAt?: Date;
};

async function createUser({
  status = "APPROVED", role = "VIEWER", name = "Presence test user", linked = true,
  matchingAccount = true, approvedBy, approvedAt = new Date(),
}: FixtureOptions = {}) {
  const id = randomUUID();
  const email = `${id}@presence.example`;
  const subject = `presence-${id}`;
  await owner.query(
    `INSERT INTO app.users (id,email,name,google_id,email_verified,status,role,approved_by,approved_at)
     VALUES ($1,$2,$3,$4,now(),$5::app.user_status,$6,$7,
       CASE WHEN $5::app.user_status='APPROVED' THEN $8::timestamptz ELSE NULL END)`,
    [id, email, name, subject, status, role, approvedBy ?? null, approvedAt],
  );
  if (linked) {
    await owner.query(
      "INSERT INTO app.accounts (user_id,type,provider,provider_account_id) VALUES ($1,'oidc','google',$2)",
      [id, matchingAccount ? subject : `mismatched-${id}`],
    );
  }
  return { id, email, name };
}

async function createSession(userId: string, expired = false) {
  const sessionToken = randomUUID();
  await owner.query(
    "INSERT INTO app.sessions(session_token,user_id,expires) VALUES ($1,$2,now()+$3::interval)",
    [sessionToken, userId, expired ? "-1 minute" : "1 hour"],
  );
  return sessionToken;
}

async function isOnline(userId: string) {
  return (await listApprovedUsers(getDb())).users.find((user) => user.id === userId)?.online;
}

async function storedPresence() {
  return (await owner.query<{ session_token: string; tab_id: string; last_seen: Date }>(
    "SELECT session_token,tab_id,last_seen FROM app.user_presence ORDER BY session_token,tab_id",
  )).rows;
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

describe("presence persisted by the runtime database role", () => {
  it("uses database time and refreshes an existing tab instead of inserting duplicates", async () => {
    const user = await createUser();
    const token = await createSession(user.id);
    const tab = randomUUID();
    const { rows: [before] } = await owner.query<{ time: Date }>("SELECT clock_timestamp() AS time");
    expect(await heartbeat(getDb(), user.id, token, tab)).toBe(true);
    const { rows: [after] } = await owner.query<{ time: Date }>("SELECT clock_timestamp() AS time");
    const [stored] = await storedPresence();
    expect(stored.last_seen.getTime()).toBeGreaterThanOrEqual(before.time.getTime());
    expect(stored.last_seen.getTime()).toBeLessThanOrEqual(after.time.getTime());
    expect(await isOnline(user.id)).toBe(true);
    await owner.query("UPDATE app.user_presence SET last_seen=now()-interval '2 minutes'");
    expect(await heartbeat(getDb(), user.id, token, tab)).toBe(true);
    expect(await storedPresence()).toHaveLength(1);
    expect(await isOnline(user.id)).toBe(true);
  });

  it.each(["PENDING", "REJECTED"] as const)("cannot publish presence for a %s account", async (status) => {
    const user = await createUser({ status });
    const token = await createSession(user.id);
    expect(await heartbeat(getDb(), user.id, token, randomUUID())).toBe(false);
    expect(await storedPresence()).toHaveLength(0);
  });

  it.each([{ linked: false }, { matchingAccount: false }])(
    "requires complete verified Google linkage: %j", async (options) => {
      const user = await createUser(options);
      const token = await createSession(user.id);
      expect(await heartbeat(getDb(), user.id, token, randomUUID())).toBe(false);
      expect(await storedPresence()).toHaveLength(0);
    },
  );

  it("requires an existing unexpired session belonging to the account", async () => {
    const user = await createUser();
    const other = await createUser();
    const expired = await createSession(user.id, true);
    const otherToken = await createSession(other.id);
    for (const token of [randomUUID(), expired, otherToken]) {
      expect(await heartbeat(getDb(), user.id, token, randomUUID())).toBe(false);
    }
    expect(await storedPresence()).toHaveLength(0);
  });

  it("rejects invalid account IDs, tab IDs, and missing session tokens without database errors", async () => {
    const user = await createUser();
    const token = await createSession(user.id);
    const tab = randomUUID();
    for (const [userId, sessionToken, tabId] of [
      ["invalid-user", token, tab], [user.id, token, "invalid-tab"], [user.id, "", tab],
    ]) {
      expect(await heartbeat(getDb(), userId, sessionToken, tabId)).toBe(false);
      expect(await leave(getDb(), userId, sessionToken, tabId)).toBe(false);
    }
    expect(await storedPresence()).toHaveLength(0);
  });

  it("keeps the user online while any tab in any session is still open", async () => {
    const user = await createUser();
    const tokens = [await createSession(user.id), await createSession(user.id)];
    const tabs = [randomUUID(), randomUUID(), randomUUID()];
    await heartbeat(getDb(), user.id, tokens[0], tabs[0]);
    await heartbeat(getDb(), user.id, tokens[0], tabs[1]);
    await heartbeat(getDb(), user.id, tokens[1], tabs[2]);
    expect(await leave(getDb(), user.id, tokens[0], tabs[0])).toBe(true);
    expect(await isOnline(user.id)).toBe(true);
    expect(await storedPresence()).toHaveLength(2);
    await leave(getDb(), user.id, tokens[0], tabs[1]);
    expect(await isOnline(user.id)).toBe(true);
    await leave(getDb(), user.id, tokens[1], tabs[2]);
    expect(await isOnline(user.id)).toBe(false);
    expect(await storedPresence()).toHaveLength(0);
  });

  it("does not let a different account remove another user's presence", async () => {
    const user = await createUser();
    const other = await createUser();
    const token = await createSession(user.id);
    const tab = randomUUID();
    await heartbeat(getDb(), user.id, token, tab);
    expect(await leave(getDb(), other.id, token, tab)).toBe(false);
    expect(await isOnline(user.id)).toBe(true);
    expect(await storedPresence()).toHaveLength(1);
  });

  it("removes a logged-out session's presence through its database foreign key", async () => {
    const user = await createUser();
    const token = await createSession(user.id);
    await heartbeat(getDb(), user.id, token, randomUUID());
    await getPool().query("DELETE FROM app.sessions WHERE session_token=$1", [token]);
    expect(await storedPresence()).toHaveLength(0);
    expect(await isOnline(user.id)).toBe(false);
  });

  it("marks a disconnected tab offline after 60 seconds without relying on a browser leave request", async () => {
    const user = await createUser();
    const token = await createSession(user.id);
    await heartbeat(getDb(), user.id, token, randomUUID());
    await owner.query("UPDATE app.user_presence SET last_seen=now()-interval '59 seconds'");
    expect(await isOnline(user.id)).toBe(true);
    await owner.query("UPDATE app.user_presence SET last_seen=now()-interval '61 seconds'");
    expect(await isOnline(user.id)).toBe(false);
  });

  it("cleans stale tabs only within the session making the next heartbeat", async () => {
    const user = await createUser();
    const token = await createSession(user.id);
    const otherToken = await createSession(user.id);
    const staleTab = randomUUID();
    const otherStaleTab = randomUUID();
    const freshTab = randomUUID();
    await heartbeat(getDb(), user.id, token, staleTab);
    await heartbeat(getDb(), user.id, otherToken, otherStaleTab);
    await owner.query("UPDATE app.user_presence SET last_seen=now()-interval '2 minutes'");
    await heartbeat(getDb(), user.id, token, freshTab);
    const stored = await storedPresence();
    expect(stored.map((row) => row.tab_id).sort()).toEqual([freshTab, otherStaleTab].sort());
    expect(await isOnline(user.id)).toBe(true);
  });

  it("disregards fresh heartbeats when their session expires or their Google linkage is removed", async () => {
    const user = await createUser();
    const token = await createSession(user.id);
    const tab = randomUUID();
    await heartbeat(getDb(), user.id, token, tab);
    await owner.query("UPDATE app.sessions SET expires=now()-interval '1 second' WHERE session_token=$1", [token]);
    expect(await isOnline(user.id)).toBe(false);
    expect(await heartbeat(getDb(), user.id, token, tab)).toBe(false);
    await owner.query("UPDATE app.sessions SET expires=now()+interval '1 hour' WHERE session_token=$1", [token]);
    await owner.query("DELETE FROM app.accounts WHERE user_id=$1", [user.id]);
    expect(await heartbeat(getDb(), user.id, token, tab)).toBe(false);
    expect(await isOnline(user.id)).not.toBe(true);
  });
});

describe("approved account directory", () => {
  it("includes the approving administrator's name and email and the original approval date", async () => {
    const administrator = await createUser({ name: "Directory administrator", role: "ADMIN" });
    const approvedAt = new Date("2026-01-15T08:30:00.000Z");
    const viewer = await createUser({ name: "Approved viewer", approvedBy: administrator.id, approvedAt });
    const directory = await listApprovedUsers(getDb());
    const stored = directory.users.find((user) => user.id === viewer.id);
    expect(stored).toMatchObject({
      id: viewer.id, name: viewer.name, email: viewer.email, approvedAt: approvedAt.toISOString(),
      approvedBy: { name: administrator.name, email: administrator.email },
      approvalSource: "administrator", online: false,
    });
    expect(Object.keys(stored!).sort()).toEqual([
      "approvalSource", "approvedAt", "approvedBy", "email", "id", "name", "online",
    ]);
  });

  it("retains approval attribution after an administrator's role changes", async () => {
    const administrator = await createUser({ role: "ADMIN", name: "Previous administrator" });
    const viewer = await createUser({ approvedBy: administrator.id });
    await owner.query("UPDATE app.users SET role='VIEWER' WHERE id=$1", [administrator.id]);
    const directory = await listApprovedUsers(getDb());
    expect(directory.users.find((user) => user.id === viewer.id)).toMatchObject({
      approvedBy: { name: administrator.name, email: administrator.email }, approvalSource: "administrator",
    });
  });

  it("labels a real SUPER_ADMIN_EMAILS bootstrap without inventing a human approver", async () => {
    const administrator = await createUser({ status: "PENDING" });
    await getDb().transaction(async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, administrator.id));
      await bootstrapAdmin(tx, user, administrator.email);
    });
    const directory = await listApprovedUsers(getDb());
    expect(directory.users[0]).toMatchObject({ id: administrator.id, approvedBy: null, approvalSource: "bootstrap" });
  });

  it("reports missing approval history honestly, including a deleted administrator", async () => {
    const administrator = await createUser({ role: "ADMIN" });
    const viewer = await createUser({ approvedBy: administrator.id });
    const legacy = await createUser({ name: null });
    await owner.query("DELETE FROM app.users WHERE id=$1", [administrator.id]);
    const directory = await listApprovedUsers(getDb());
    for (const id of [viewer.id, legacy.id]) {
      expect(directory.users.find((user) => user.id === id)).toMatchObject({ approvedBy: null, approvalSource: "unavailable" });
    }
  });

  it("uses only the latest matching approval evidence and verifies that bootstrap was attributed to the account itself", async () => {
    const administrator = await createUser({ role: "ADMIN" });
    const target = await createUser();
    await owner.query(
      `INSERT INTO app.audit_logs(user_id,action,target_type,target_id,timestamp,metadata)
       VALUES ($1,'USER_APPROVED','user',($1::uuid)::text,now()-interval '1 hour','{"reason":"SUPER_ADMIN_EMAILS"}')`,
      [target.id],
    );
    const entry = async () => (await listApprovedUsers(getDb())).users.find((user) => user.id === target.id);
    expect(await entry()).toMatchObject({ approvalSource: "bootstrap", approvedBy: null });
    await owner.query(
      `INSERT INTO app.audit_logs(user_id,action,target_type,target_id,timestamp,metadata)
       VALUES ($1,'USER_APPROVED','user',$2,now(),'{"reason":"SUPER_ADMIN_EMAILS"}')`,
      [administrator.id, target.id],
    );
    // A later approval by someone else must not inherit an old bootstrap label.
    expect(await entry()).toMatchObject({ approvalSource: "unavailable", approvedBy: null });
    await owner.query(
      `INSERT INTO app.audit_logs(user_id,action,target_type,target_id,timestamp,metadata)
       VALUES ($1,'USER_APPROVED','different-target-type',($1::uuid)::text,now()+interval '1 second','{"reason":"SUPER_ADMIN_EMAILS"}'),
              ($1,'ROLE_CHANGED','user',($1::uuid)::text,now()+interval '2 seconds','{"reason":"SUPER_ADMIN_EMAILS"}'),
              ($1,'USER_APPROVED','user',$2,now()+interval '3 seconds','{"reason":"SUPER_ADMIN_EMAILS"}')`,
      [target.id, randomUUID()],
    );
    expect(await entry()).toMatchObject({ approvalSource: "unavailable", approvedBy: null });
  });

  it("paginates approved accounts in stable pages of 20 while excluding pending and rejected accounts", async () => {
    const eligible = [];
    for (let index = 0; index < 21; index += 1) eligible.push((await createUser()).id);
    await createUser({ status: "PENDING" });
    await createUser({ status: "REJECTED" });
    await createUser({ linked: false });
    await createUser({ matchingAccount: false });
    const first = await listApprovedUsers(getDb(), 1);
    const second = await listApprovedUsers(getDb(), 2);
    expect(first).toMatchObject({ total: 21, page: 1, totalPages: 2 });
    expect(second).toMatchObject({ total: 21, page: 2, totalPages: 2 });
    expect(first.users).toHaveLength(20);
    expect(second.users).toHaveLength(1);
    expect([...first.users, ...second.users].map((user) => user.id).sort()).toEqual(eligible.sort());
    expect(await listApprovedUsers(getDb(), 1)).toEqual(first);
  });

  it("returns an empty first page and normalizes invalid page values", async () => {
    await createUser({ status: "PENDING" });
    for (const page of [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 999_999]) {
      expect(await listApprovedUsers(getDb(), page)).toEqual({ users: [], total: 0, page: 1, totalPages: 1 });
    }
    const viewer = await createUser();
    const directory = await listApprovedUsers(getDb(), 999_999);
    expect(directory).toMatchObject({ total: 1, page: 1, totalPages: 1 });
    expect(directory.users.map((user) => user.id)).toEqual([viewer.id]);
  });
});
