import "server-only";
import { and, asc, count, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { lockUserAdministration } from "@/server/auth/service";
import type { Database } from "@/server/db";
import { accounts, auditLogs, users } from "@/server/db/schema";

export class ApprovalError extends Error {
  constructor(public readonly code: "forbidden" | "not-pending" | "invalid-user") {
    super(code);
    this.name = "ApprovalError";
  }
}

const linkedGoogleAccount = and(
  eq(accounts.userId, users.id),
  eq(accounts.provider, "google"),
  eq(accounts.providerAccountId, users.googleId),
  isNotNull(users.emailVerified),
);
const pendingViewer = and(eq(users.status, "PENDING"), eq(users.role, "VIEWER"));
const pageSize = 20;

/** Caller must requireAdmin before reading another user's registration details. */
export async function listPendingUsers(db: Database, requestedPage = 1) {
  const [summary] = await db.select({ total: count() }).from(users)
    .innerJoin(accounts, linkedGoogleAccount).where(pendingViewer);
  const total = summary.total;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(totalPages,
    Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1);
  const pending = await db.select({
    id: users.id, name: users.name, email: users.email, createdAt: users.createdAt,
  }).from(users).innerJoin(accounts, linkedGoogleAccount).where(pendingViewer)
    .orderBy(asc(users.createdAt), asc(users.id)).limit(pageSize).offset((page - 1) * pageSize);
  return { users: pending, total, page, totalPages };
}

/** Only the authenticated server action supplies actorId; form input never supplies it. */
export async function approvePendingUser(db: Database, actorId: string, targetId: string) {
  if (!z.uuid().safeParse(actorId).success) throw new ApprovalError("forbidden");
  if (!z.uuid().safeParse(targetId).success) throw new ApprovalError("invalid-user");
  return db.transaction(async (tx) => {
    // Serialize with bootstrap and the development CLI, then recheck live privileges.
    await lockUserAdministration(tx);
    const [actor] = await tx.select({ status: users.status, role: users.role }).from(users)
      .innerJoin(accounts, linkedGoogleAccount).where(eq(users.id, actorId)).limit(1);
    if (actor?.status !== "APPROVED" || actor.role !== "ADMIN") throw new ApprovalError("forbidden");

    const [target] = await tx.select({ status: users.status, role: users.role }).from(users)
      .innerJoin(accounts, linkedGoogleAccount).where(eq(users.id, targetId)).limit(1);
    if (!target) throw new ApprovalError("invalid-user");
    if (target.status === "APPROVED" && target.role === "VIEWER") return "already-approved" as const;
    if (target.status !== "PENDING" || target.role !== "VIEWER") throw new ApprovalError("not-pending");

    await tx.update(users).set({
      status: "APPROVED", role: "VIEWER", approvedBy: actorId, approvedAt: new Date(), updatedAt: new Date(),
    }).where(eq(users.id, targetId));
    await tx.insert(auditLogs).values({
      userId: actorId, action: "USER_APPROVED", targetId,
      metadata: { source: "admin_portal", previousStatus: "PENDING", status: "APPROVED", role: "VIEWER" },
    });
    return "approved" as const;
  });
}
