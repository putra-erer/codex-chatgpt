import "server-only";
import { and, asc, count, desc, eq, isNotNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "@/server/db";
import { accounts, auditLogs, sessions, userPresence, users } from "@/server/db/schema";
import { presenceTimeoutSeconds } from "@/server/presence/service";

export type ApprovedUser = {
  id: string;
  name: string | null;
  email: string;
  approvedAt: string | null;
  approvedBy: { name: string | null; email: string } | null;
  approvalSource: "administrator" | "bootstrap" | "unavailable";
  online: boolean;
};

export type ApprovedUsersPage = {
  users: ApprovedUser[];
  total: number;
  page: number;
  totalPages: number;
};

const linkedGoogleAccount = and(
  eq(accounts.userId, users.id), eq(accounts.provider, "google"),
  eq(accounts.providerAccountId, users.googleId), isNotNull(users.emailVerified),
);
const approved = eq(users.status, "APPROVED");
const pageSize = 20;
const approver = alias(users, "approver");

/** Caller must requireAdmin before reading account details or presence. Tokens never leave this service. */
export async function listApprovedUsers(db: Database, requestedPage = 1): Promise<ApprovedUsersPage> {
  const [summary] = await db.select({ total: count() }).from(users)
    .innerJoin(accounts, linkedGoogleAccount).where(approved);
  const total = summary.total;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(totalPages,
    Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1);
  const rows = await db.select({
    id: users.id, name: users.name, email: users.email, approvedAt: users.approvedAt,
    approverId: approver.id, approverName: approver.name, approverEmail: approver.email,
    approvalReason: sql<string | null>`(
      select case when ${auditLogs.userId} = ${users.id}
        then ${auditLogs.metadata}->>'reason' else null end from ${auditLogs}
      where ${auditLogs.targetId} = ${users.id}::text
        and ${auditLogs.targetType} = 'user' and ${auditLogs.action} = 'USER_APPROVED'
      order by ${auditLogs.timestamp} desc, ${auditLogs.id} desc limit 1
    )`,
    online: sql<boolean>`exists (
      select 1 from ${sessions} inner join ${userPresence}
        on ${userPresence.sessionToken} = ${sessions.sessionToken}
      where ${sessions.userId} = ${users.id} and ${sessions.expires} > now()
        and ${userPresence.lastSeen} > now() - ${presenceTimeoutSeconds} * interval '1 second'
    )`,
  }).from(users).innerJoin(accounts, linkedGoogleAccount)
    .leftJoin(approver, eq(users.approvedBy, approver.id)).where(approved)
    .orderBy(desc(users.approvedAt), asc(users.id)).limit(pageSize).offset((page - 1) * pageSize);

  return {
    users: rows.map((row) => ({
      id: row.id, name: row.name, email: row.email, approvedAt: row.approvedAt?.toISOString() ?? null,
      approvedBy: row.approverId && row.approverEmail
        ? { name: row.approverName, email: row.approverEmail } : null,
      approvalSource: row.approverId ? "administrator"
        : row.approvalReason === "SUPER_ADMIN_EMAILS" ? "bootstrap" : "unavailable",
      online: row.online,
    })),
    total, page, totalPages,
  };
}
