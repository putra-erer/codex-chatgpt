import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, getPool } from "@/server/db";
import {
  listManagedUsers,
  manageUser,
  userSummary,
} from "@/server/users/management";
import { userFilters, type UserChange } from "@/lib/users/management";

let owner: Pool;
const configured = process.env.SUPER_ADMIN_EMAILS;
async function fixture(
  status = "PENDING",
  role = "VIEWER",
  linked = true,
  email?: string,
) {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO app.users(id,name,email,google_id,email_verified,status,role,approved_at)
    VALUES($1,'Management User',$2,$5,now(),$3::app.user_status,$4,CASE WHEN $3::app.user_status='APPROVED' THEN now() ELSE NULL END)`,
    [id, email ?? `${id}@management.example`, status, role, id],
  );
  if (linked)
    await owner.query(
      "INSERT INTO app.accounts(user_id,type,provider,provider_account_id) VALUES($1,'oidc','google',$2)",
      [id, id],
    );
  return id;
}
async function stored(id: string) {
  return (
    await owner.query(
      "SELECT *,updated_at::text AS version FROM app.users WHERE id=$1",
      [id],
    )
  ).rows[0];
}
async function change(
  actor: string,
  target: string,
  action: "approve" | "reject" | "role",
  role: "VIEWER" | "ADMIN" = "VIEWER",
) {
  return manageUser(getDb(), actor, {
    action,
    role,
    userId: target,
    version: (await stored(target)).version,
  } as UserChange);
}
beforeAll(async () => {
  const name = process.env.PORTAL_INTEGRATION_DATABASE;
  if (!name || !/^portal_test_[a-f0-9]{32}$/.test(name))
    throw new Error("Use test:integration for isolation.");
  owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
  for (const pool of [owner, getPool()])
    expect(
      (await pool.query("SELECT current_database() AS name")).rows[0].name,
    ).toBe(name);
});
beforeEach(async () => {
  process.env.SUPER_ADMIN_EMAILS = "protected@management.example";
  await owner.query("TRUNCATE app.users CASCADE");
});
afterAll(async () => {
  if (configured === undefined) delete process.env.SUPER_ADMIN_EMAILS;
  else process.env.SUPER_ADMIN_EMAILS = configured;
  await Promise.all([owner?.end(), getPool().end()]);
});

describe("user management with the restricted runtime role", () => {
  it("approves, preserves attribution during role changes, rejects and reapproves atomically", async () => {
    const actor = await fixture("APPROVED", "ADMIN"),
      target = await fixture();
    expect(await change(actor, target, "approve")).toBe("approved");
    const approved = await stored(target);
    expect(approved).toMatchObject({
      status: "APPROVED",
      role: "VIEWER",
      approved_by: actor,
    });
    expect(approved.approved_at).toBeInstanceOf(Date);
    await change(actor, target, "role", "ADMIN");
    expect(await stored(target)).toMatchObject({
      role: "ADMIN",
      approved_by: actor,
      approved_at: approved.approved_at,
    });
    await owner.query(
      "INSERT INTO app.sessions VALUES($1,$2,now()+interval '1 hour')",
      [randomUUID(), target],
    );
    await change(actor, target, "reject");
    expect(await stored(target)).toMatchObject({
      status: "REJECTED",
      approved_at: null,
      approved_by: null,
    });
    expect(
      (
        await owner.query("SELECT * FROM app.sessions WHERE user_id=$1", [
          target,
        ])
      ).rows,
    ).toHaveLength(0);
    await change(actor, target, "approve");
    expect(await stored(target)).toMatchObject({
      status: "APPROVED",
      role: "ADMIN",
      approved_by: actor,
    });
    expect(
      (
        await owner.query(
          "SELECT action FROM app.audit_logs WHERE target_id=$1 ORDER BY timestamp",
          [target],
        )
      ).rows.map((r) => r.action),
    ).toEqual([
      "USER_APPROVED",
      "ROLE_CHANGED",
      "USER_REJECTED",
      "USER_APPROVED",
    ]);
  });
  it("preserves an explicitly assigned role when approving a pending account", async () => {
    const actor = await fixture("APPROVED", "ADMIN"),
      target = await fixture();
    await change(actor, target, "role", "ADMIN");
    await change(actor, target, "approve");
    expect(await stored(target)).toMatchObject({
      status: "APPROVED",
      role: "ADMIN",
    });
  });
  it.each([
    ["APPROVED", "VIEWER"],
    ["PENDING", "VIEWER"],
    ["PENDING", "ADMIN"],
    ["REJECTED", "VIEWER"],
    ["REJECTED", "ADMIN"],
  ])("blocks all actions for %s %s", async (status, role) => {
    const actor = await fixture(status, role),
      target = await fixture();
    for (const action of ["approve", "reject", "role"] as const)
      await expect(
        change(actor, target, action, "ADMIN"),
      ).rejects.toMatchObject({ code: "forbidden" });
    expect((await stored(target)).status).toBe("PENDING");
  });
  it("requires a real linked administrator and a linked target", async () => {
    const actor = await fixture("APPROVED", "ADMIN"),
      orphan = await fixture("APPROVED", "ADMIN", false),
      target = await fixture();
    await expect(change(orphan, target, "approve")).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(change(randomUUID(), target, "approve")).rejects.toMatchObject(
      { code: "forbidden" },
    );
    await expect(change(actor, orphan, "reject")).rejects.toMatchObject({
      code: "identity",
    });
    await expect(
      manageUser(getDb(), actor, {
        action: "approve",
        userId: randomUUID(),
        version: "unknown",
      }),
    ).rejects.toMatchObject({ code: "missing" });
  });
  it.each(["reject", "role"] as const)(
    "protects the last approved administrator from %s",
    async (action) => {
      const actor = await fixture("APPROVED", "ADMIN");
      await fixture("PENDING", "ADMIN");
      await expect(change(actor, actor, action)).rejects.toMatchObject({
        code: "last-admin",
      });
      expect(await stored(actor)).toMatchObject({
        status: "APPROVED",
        role: "ADMIN",
      });
    },
  );
  it("allows self-demotion when another approved administrator exists and immediately removes mutation access", async () => {
    const actor = await fixture("APPROVED", "ADMIN"),
      other = await fixture("APPROVED", "ADMIN");
    await change(actor, actor, "role", "VIEWER");
    await expect(change(actor, other, "reject")).rejects.toMatchObject({
      code: "forbidden",
    });
  });
  it("serializes simultaneous self-demotions, leaving one approved administrator", async () => {
    const first = await fixture("APPROVED", "ADMIN"),
      second = await fixture("APPROVED", "ADMIN");
    const outcomes = await Promise.allSettled([
      change(first, first, "role"),
      change(second, second, "role"),
    ]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await userSummary(getDb())).administrators).toBe(1);
  });
  it("protects exact normalized bootstrap emails without protecting substring lookalikes", async () => {
    process.env.SUPER_ADMIN_EMAILS = "  PROTECTED@MANAGEMENT.EXAMPLE  ";
    const actor = await fixture("APPROVED", "ADMIN"),
      protectedId = await fixture(
        "APPROVED",
        "ADMIN",
        true,
        "protected@management.example",
      );
    for (const action of ["reject", "role"] as const)
      await expect(change(actor, protectedId, action)).rejects.toMatchObject({
        code: "bootstrap",
      });
    const similar = await fixture(
      "APPROVED",
      "ADMIN",
      true,
      "notprotected@management.example",
    );
    expect(await change(actor, similar, "reject")).toBe("rejected");
  });
  it("rejects stale forms without overwriting newer decisions or repeating audit entries", async () => {
    const actor = await fixture("APPROVED", "ADMIN"),
      target = await fixture();
    const input = {
      action: "approve" as const,
      userId: target,
      version: (await stored(target)).version,
    };
    await manageUser(getDb(), actor, input);
    await expect(
      manageUser(getDb(), actor, { ...input, action: "reject" }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await change(actor, target, "approve")).toBe("unchanged");
    expect(
      (
        await owner.query("SELECT * FROM app.audit_logs WHERE target_id=$1", [
          target,
        ])
      ).rows,
    ).toHaveLength(1);
  });
  it("rolls back status and session deletion when audit insertion fails", async () => {
    const actor = await fixture("APPROVED", "ADMIN"),
      target = await fixture("APPROVED");
    await owner.query(
      "INSERT INTO app.sessions VALUES($1,$2,now()+interval '1 hour')",
      [randomUUID(), target],
    );
    await owner.query("REVOKE INSERT ON app.audit_logs FROM gis_app");
    try {
      await expect(change(actor, target, "reject")).rejects.toBeDefined();
    } finally {
      await owner.query("GRANT INSERT ON app.audit_logs TO gis_app");
    }
    expect((await stored(target)).status).toBe("APPROVED");
    expect(
      (
        await owner.query("SELECT * FROM app.sessions WHERE user_id=$1", [
          target,
        ])
      ).rows,
    ).toHaveLength(1);
  });
  it("filters by status, role and literal name/email, pages stably and returns no authentication fields", async () => {
    await fixture("APPROVED", "ADMIN");
    await fixture("REJECTED");
    const target = await fixture(
      "PENDING",
      "VIEWER",
      true,
      "under_score@management.example",
    );
    for (let i = 0; i < 22; i++) await fixture();
    expect(
      (
        await listManagedUsers(
          getDb(),
          userFilters({ status: "PENDING", role: "VIEWER" }),
        )
      ).total,
    ).toBe(23);
    const page = await listManagedUsers(getDb(), userFilters({ page: "999" }));
    expect(page.page).toBe(2);
    expect(page.users).toHaveLength(5);
    const found = await listManagedUsers(getDb(), userFilters({ q: "_" }));
    expect(found.users.map((r) => r.id)).toEqual([target]);
    expect(found.users[0]).not.toHaveProperty("googleId");
    expect(found.users[0]).not.toHaveProperty("sessionToken");
    expect(
      (await listManagedUsers(getDb(), userFilters({ q: "%' OR 1=1; --" })))
        .total,
    ).toBe(0);
    expect(await userSummary(getDb())).toEqual({
      total: 25,
      pending: 23,
      approved: 1,
      rejected: 1,
      administrators: 1,
    });
  });
});

describe("targeted legacy GIS cleanup", () => {
  it("removes only known marked system layers and retains users and unrelated data on repeat runs", async () => {
    const person = await fixture("APPROVED", "ADMIN");
    const known = "11111111-1111-4111-8111-111111111111",
      preserved = "22222222-2222-4222-8222-222222222222";
    const table = (id: string) => `layer_${id.replaceAll("-", "")}`;
    for (const id of [known, preserved]) {
      await owner.query(
        `CREATE TABLE IF NOT EXISTS gis.${table(id)}(feature_id integer,geom geometry(Point,4326))`,
      );
      await owner.query(
        "INSERT INTO app.layers(id,name,layer_type,source_type,table_name,storage_metadata,uploaded_by) VALUES($1,'Migration fixture','VECTOR','GEOJSON',$2,'{\"demo\":true}',$3)",
        [id, table(id), id === preserved ? person : null],
      );
    }
    const real = randomUUID();
    await owner.query(
      "INSERT INTO app.layers(id,name,layer_type,source_type,table_name,uploaded_by) VALUES($1,'Retained layer','VECTOR','POSTGIS',$2,$3)",
      [real, table(real), person],
    );
    const migration = readFileSync(
      "migrations/0004_remove_gis_demo.sql",
      "utf8",
    );
    try {
      await owner.query(migration);
      await owner.query(migration);
      expect(
        (await owner.query("SELECT id FROM app.layers ORDER BY id")).rows
          .map((r) => r.id)
          .sort(),
      ).toEqual([preserved, real].sort());
      expect(
        (
          await owner.query("SELECT to_regclass($1) AS name", [
            `gis.${table(known)}`,
          ])
        ).rows[0].name,
      ).toBeNull();
      expect(
        (
          await owner.query("SELECT to_regclass($1) AS name", [
            `gis.${table(preserved)}`,
          ])
        ).rows[0].name,
      ).not.toBeNull();
      expect((await stored(person)).status).toBe("APPROVED");
    } finally {
      await owner.query("DELETE FROM app.layers WHERE id = ANY($1::uuid[])", [
        [known, preserved, real],
      ]);
      await owner.query(
        `DROP TABLE IF EXISTS gis.${table(known)},gis.${table(preserved)}`,
      );
    }
  });
});
