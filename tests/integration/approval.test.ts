import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, getPool } from "@/server/db";
import { auditLogs, users, type UserRole, type UserStatus } from "@/server/db/schema";
import { approvePendingUser, listPendingUsers } from "@/server/users/approval";

let owner: Pool;

type FixtureOptions = {
  status?: UserStatus;
  role?: UserRole;
  linked?: boolean;
  verified?: boolean;
  matchingAccount?: boolean;
  hasGoogleId?: boolean;
};

async function createUser({
  status = "PENDING", role = "VIEWER", linked = true, verified = true,
  matchingAccount = true, hasGoogleId = true,
}: FixtureOptions = {}) {
  const id = randomUUID();
  const subject = `approval-test-${id}`;
  await owner.query(
    `INSERT INTO app.users (id,email,name,google_id,email_verified,status,role,approved_at)
     VALUES ($1,$2,'Approval test user',$3,$4,$5::app.user_status,$6,
       CASE WHEN $5::app.user_status='APPROVED' THEN now() ELSE NULL END)`,
    [id, `${id}@approval.example`, hasGoogleId ? subject : null,
      verified ? new Date() : null, status, role],
  );
  if (linked) {
    await owner.query(
      "INSERT INTO app.accounts (user_id,type,provider,provider_account_id) VALUES ($1,'oidc','google',$2)",
      [id, matchingAccount ? subject : `mismatched-${id}`],
    );
  }
  return id;
}

function createAdmin() {
  return createUser({ status: "APPROVED", role: "ADMIN" });
}

async function storedUser(id: string) {
  const [user] = await getDb().select().from(users).where(eq(users.id, id));
  return user;
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

describe("administrator approval against the runtime database role", () => {
  it("approves a pending viewer and records the authenticated administrator atomically", async () => {
    const administrator = await createAdmin();
    const target = await createUser();
    expect(await approvePendingUser(getDb(), administrator, target)).toBe("approved");
    const stored = await storedUser(target);
    expect(stored).toMatchObject({ status: "APPROVED", role: "VIEWER", approvedBy: administrator });
    expect(stored.approvedAt).toBeInstanceOf(Date);
    const entries = await getDb().select().from(auditLogs);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ userId: administrator, action: "USER_APPROVED", targetType: "user", targetId: target });
  });

  it.each([
    ["PENDING", "ADMIN"],
    ["REJECTED", "ADMIN"],
    ["APPROVED", "VIEWER"],
  ] as const)("rejects approval by a %s %s even when the target is valid", async (status, role) => {
    const actor = await createUser({ status, role });
    const target = await createUser();
    await expect(approvePendingUser(getDb(), actor, target)).rejects.toMatchObject({ code: "forbidden" });
    expect(await storedUser(target)).toMatchObject({ status: "PENDING", role: "VIEWER", approvedBy: null, approvedAt: null });
    expect(await getDb().select().from(auditLogs)).toHaveLength(0);
  });

  it.each([
    { linked: false },
    { matchingAccount: false },
  ])("rejects an administrator whose Google account linkage is invalid: %j", async (options) => {
    const actor = await createUser({ status: "APPROVED", role: "ADMIN", ...options });
    const target = await createUser();
    await expect(approvePendingUser(getDb(), actor, target)).rejects.toMatchObject({ code: "forbidden" });
    expect((await storedUser(target)).status).toBe("PENDING");
    expect(await getDb().select().from(auditLogs)).toHaveLength(0);
  });

  it("rejects a nonexistent administrator", async () => {
    const target = await createUser();
    await expect(approvePendingUser(getDb(), randomUUID(), target)).rejects.toMatchObject({ code: "forbidden" });
    expect((await storedUser(target)).status).toBe("PENDING");
  });

  it.each(["", "not-a-uuid", randomUUID()])("rejects an invalid or unknown target (%s)", async (target) => {
    const administrator = await createAdmin();
    await expect(approvePendingUser(getDb(), administrator, target)).rejects.toMatchObject({ code: "invalid-user" });
    expect(await getDb().select().from(auditLogs)).toHaveLength(0);
  });

  it.each([
    { linked: false },
    { matchingAccount: false },
    { verified: false },
    { hasGoogleId: false },
  ])("rejects a target with an incomplete verified Google identity: %j", async (options) => {
    const administrator = await createAdmin();
    const target = await createUser(options);
    await expect(approvePendingUser(getDb(), administrator, target)).rejects.toMatchObject({ code: "invalid-user" });
    expect(await storedUser(target)).toMatchObject({ status: "PENDING", approvedBy: null, approvedAt: null });
    expect(await getDb().select().from(auditLogs)).toHaveLength(0);
  });

  it.each([
    ["REJECTED", "VIEWER"],
    ["PENDING", "ADMIN"],
    ["APPROVED", "ADMIN"],
  ] as const)("does not use approval to modify a %s %s", async (status, role) => {
    const administrator = await createAdmin();
    const target = await createUser({ status, role });
    const before = await storedUser(target);
    await expect(approvePendingUser(getDb(), administrator, target)).rejects.toMatchObject({ code: "not-pending" });
    expect(await storedUser(target)).toEqual(before);
    expect(await getDb().select().from(auditLogs)).toHaveLength(0);
  });

  it("makes repeated approval harmless without replacing its original attribution or timestamp", async () => {
    const firstAdmin = await createAdmin();
    const secondAdmin = await createAdmin();
    const target = await createUser();
    expect(await approvePendingUser(getDb(), firstAdmin, target)).toBe("approved");
    const firstApproval = await storedUser(target);
    expect(await approvePendingUser(getDb(), secondAdmin, target)).toBe("already-approved");
    expect(await storedUser(target)).toEqual(firstApproval);
    expect(await getDb().select().from(auditLogs)).toHaveLength(1);
  });

  it("serializes concurrent approvals so there is one change and one matching audit entry", async () => {
    const administrators = await Promise.all([createAdmin(), createAdmin()]);
    const target = await createUser();
    const outcomes = await Promise.all(administrators.map((actor) => approvePendingUser(getDb(), actor, target)));
    expect(outcomes.sort()).toEqual(["already-approved", "approved"]);
    const stored = await storedUser(target);
    expect(administrators).toContain(stored.approvedBy);
    const entries = await getDb().select().from(auditLogs);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ userId: stored.approvedBy, action: "USER_APPROVED", targetId: target });
  });

  it("rechecks administrator privileges after a concurrent role change releases the shared lock", async () => {
    const administrator = await createAdmin();
    const target = await createUser();
    const connection = await owner.connect();
    let approval: Promise<unknown> | undefined;
    try {
      await connection.query("BEGIN");
      await connection.query("SELECT pg_advisory_xact_lock(73429101)");
      await connection.query("UPDATE app.users SET role='VIEWER' WHERE id=$1", [administrator]);
      // Handle either outcome immediately so an early rejection cannot be unhandled.
      approval = approvePendingUser(getDb(), administrator, target).then(
        (result) => ({ result }), (error: unknown) => ({ error }),
      );
      const deadline = Date.now() + 5_000;
      let waiting = false;
      while (Date.now() < deadline) {
        const { rows: [activity] } = await owner.query<{ waiting: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
            AND usename='gis_app' AND wait_event='advisory') AS waiting`,
        );
        if (activity.waiting) {
          waiting = true;
          break;
        }
        await delay(20);
      }
      expect(waiting).toBe(true);
      await connection.query("COMMIT");
      expect(await approval).toMatchObject({ error: { code: "forbidden" } });
      expect((await storedUser(target)).status).toBe("PENDING");
      expect(await getDb().select().from(auditLogs)).toHaveLength(0);
    } finally {
      await connection.query("ROLLBACK");
      connection.release();
      await approval;
    }
  });

  it("rolls back approval if the audit entry cannot be saved", async () => {
    const administrator = await createAdmin();
    const target = await createUser();
    const before = await storedUser(target);
    await owner.query("ALTER TABLE app.audit_logs ADD CONSTRAINT test_reject_approval_audit CHECK (false)");
    try {
      await expect(approvePendingUser(getDb(), administrator, target)).rejects.toThrow();
      expect(await storedUser(target)).toEqual(before);
      expect(await getDb().select().from(auditLogs)).toHaveLength(0);
    } finally {
      await owner.query("ALTER TABLE app.audit_logs DROP CONSTRAINT test_reject_approval_audit");
    }
  });
});

describe("pending approval list", () => {
  it("paginates only pending viewers whose verified Google linkage is complete", async () => {
    const eligible = [];
    for (let index = 0; index < 21; index += 1) eligible.push(await createUser());
    await createUser({ status: "APPROVED" });
    await createUser({ status: "REJECTED" });
    await createUser({ role: "ADMIN" });
    await createUser({ verified: false });
    await createUser({ linked: false });
    await createUser({ matchingAccount: false });
    await createUser({ hasGoogleId: false });
    const first = await listPendingUsers(getDb(), 1);
    const second = await listPendingUsers(getDb(), 2);
    expect(first).toMatchObject({ total: 21, page: 1, totalPages: 2 });
    expect(second).toMatchObject({ total: 21, page: 2, totalPages: 2 });
    expect(first.users).toHaveLength(20);
    expect(second.users).toHaveLength(1);
    expect([...first.users, ...second.users].map((user) => user.id).sort()).toEqual(eligible.sort());
    expect(await listPendingUsers(getDb(), 1)).toEqual(first);
    for (const user of first.users) {
      expect(Object.keys(user).sort()).toEqual(["createdAt", "email", "id", "name"]);
    }
  });

  it("returns an empty first page when no eligible accounts are waiting", async () => {
    await createAdmin();
    await createUser({ status: "REJECTED" });
    const result = await listPendingUsers(getDb(), 1);
    expect(result).toEqual({ users: [], total: 0, page: 1, totalPages: 1 });
  });

  it("normalizes invalid page numbers and clamps pages past the end", async () => {
    const target = await createUser();
    for (const page of [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 999_999]) {
      const result = await listPendingUsers(getDb(), page);
      expect(result).toMatchObject({ total: 1, page: 1, totalPages: 1 });
      expect(result.users.map((user) => user.id)).toEqual([target]);
    }
  });
});
