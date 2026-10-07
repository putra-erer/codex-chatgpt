import "server-only";
import { and, count, desc, eq, ilike, isNotNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { isSuperAdminEmail } from "@/server/auth/identity";
import { lockUserAdministration } from "@/server/auth/service";
import type { Database } from "@/server/db";
import { accounts, auditLogs, sessions, users } from "@/server/db/schema";
import {
  changeSchema,
  type UserChange,
  type UserFilters,
} from "@/lib/users/management";

const linkedGoogle = and(
  eq(accounts.userId, users.id),
  eq(accounts.provider, "google"),
  eq(accounts.providerAccountId, users.googleId),
  isNotNull(users.emailVerified),
);
const version = sql<string>`${users.updatedAt}::text`;
const approver = alias(users, "approver");
export class UserManagementError extends Error {
  constructor(
    public readonly code:
      | "forbidden"
      | "invalid"
      | "missing"
      | "identity"
      | "conflict"
      | "bootstrap"
      | "last-admin",
  ) {
    super(code);
    this.name = "UserManagementError";
  }
}

/** Read functions are called only after requireAdmin. They expose no session or OAuth fields. */
export async function userSummary(db: Database) {
  const counts = await db
    .select({ status: users.status, role: users.role, total: count() })
    .from(users)
    .groupBy(users.status, users.role);
  const result = {
    total: 0,
    pending: 0,
    approved: 0,
    rejected: 0,
    administrators: 0,
  };
  for (const row of counts) {
    result.total += row.total;
    result[row.status.toLowerCase() as "pending" | "approved" | "rejected"] +=
      row.total;
    if (row.status === "APPROVED" && row.role === "ADMIN")
      result.administrators += row.total;
  }
  return result;
}
export async function listManagedUsers(db: Database, filters: UserFilters) {
  // Escape wildcard syntax so search is a literal substring, not an SQL pattern.
  const pattern = `%${filters.q.replace(/[\\%_]/g, "\\$&")}%`;
  const where = and(
    filters.status === "ALL" ? undefined : eq(users.status, filters.status),
    filters.role === "ALL" ? undefined : eq(users.role, filters.role),
    filters.q
      ? or(ilike(users.name, pattern), ilike(users.email, pattern))
      : undefined,
  );
  const [summary] = await db
    .select({ total: count() })
    .from(users)
    .where(where);
  const totalPages = Math.max(1, Math.ceil(summary.total / 20));
  const page = Math.min(filters.page, totalPages);
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      status: users.status,
      role: users.role,
      createdAt: users.createdAt,
      approvedAt: users.approvedAt,
      approvedBy: users.approvedBy,
      approverName: approver.name,
      approverEmail: approver.email,
      version,
      linked: sql<boolean>`${accounts.userId} IS NOT NULL`,
    })
    .from(users)
    .leftJoin(accounts, linkedGoogle)
    .leftJoin(approver, eq(users.approvedBy, approver.id))
    .where(where)
    .orderBy(desc(users.createdAt), desc(users.id))
    .limit(20)
    .offset((page - 1) * 20);
  return {
    users: rows.map((row) => ({
      ...row,
      bootstrap: isSuperAdminEmail(
        row.email,
        process.env.SUPER_ADMIN_EMAILS ?? "",
      ),
    })),
    total: summary.total,
    page,
    totalPages,
  };
}

/** actorId always comes from the authenticated session, never from form input. */
export async function manageUser(
  db: Database,
  actorId: string,
  input: UserChange,
) {
  if (!z.uuid().safeParse(actorId).success)
    throw new UserManagementError("forbidden");
  const parsed = changeSchema.safeParse(input);
  if (!parsed.success) throw new UserManagementError("invalid");
  const change = parsed.data;
  return db.transaction(async (tx) => {
    // Serialize ALL privilege changes with bootstrap, CLI and the original approval action.
    await lockUserAdministration(tx);
    const [actor] = await tx
      .select({ status: users.status, role: users.role })
      .from(users)
      .innerJoin(accounts, linkedGoogle)
      .where(eq(users.id, actorId));
    if (actor?.status !== "APPROVED" || actor.role !== "ADMIN")
      throw new UserManagementError("forbidden");
    const [target] = await tx
      .select({
        user: users,
        version,
        linked: sql<boolean>`${accounts.userId} IS NOT NULL`,
      })
      .from(users)
      .leftJoin(accounts, linkedGoogle)
      .where(eq(users.id, change.userId));
    if (!target) throw new UserManagementError("missing");
    if (!target.linked) throw new UserManagementError("identity");
    if (target.version !== change.version)
      throw new UserManagementError("conflict");
    const before = target.user;
    const status =
      change.action === "approve"
        ? "APPROVED"
        : change.action === "reject"
          ? "REJECTED"
          : before.status;
    const role = change.action === "role" ? change.role : before.role;
    if (
      isSuperAdminEmail(before.email, process.env.SUPER_ADMIN_EMAILS ?? "") &&
      (status !== "APPROVED" || role !== "ADMIN")
    )
      throw new UserManagementError("bootstrap");
    if (before.status === status && before.role === role) return "unchanged";
    if (
      before.status === "APPROVED" &&
      before.role === "ADMIN" &&
      (status !== "APPROVED" || role !== "ADMIN")
    ) {
      const [remaining] = await tx
        .select({ total: count() })
        .from(users)
        .innerJoin(accounts, linkedGoogle)
        .where(and(eq(users.status, "APPROVED"), eq(users.role, "ADMIN")));
      if (remaining.total <= 1) throw new UserManagementError("last-admin");
    }
    const now = new Date();
    await tx
      .update(users)
      .set({
        status,
        role,
        updatedAt: now,
        ...(change.action === "approve"
          ? { approvedBy: actorId, approvedAt: now }
          : {}),
        ...(change.action === "reject"
          ? { approvedBy: null, approvedAt: null }
          : {}),
      })
      .where(eq(users.id, before.id));
    if (change.action === "reject")
      await tx.delete(sessions).where(eq(sessions.userId, before.id));
    await tx
      .insert(auditLogs)
      .values({
        userId: actorId,
        action:
          change.action === "approve"
            ? "USER_APPROVED"
            : change.action === "reject"
              ? "USER_REJECTED"
              : "ROLE_CHANGED",
        targetId: before.id,
        metadata: {
          source: "admin_portal",
          previousStatus: before.status,
          status,
          previousRole: before.role,
          role,
        },
      });
    return change.action === "approve"
      ? "approved"
      : change.action === "reject"
        ? "rejected"
        : "role";
  });
}
