import { and, eq, or, sql } from "drizzle-orm";
import type { Database } from "../db";
import { accounts, auditLogs, users, type AppUser } from "../db/schema";
import { assertGoogleAccount, assertIdentityMatches, isSuperAdminEmail, type GoogleIdentity } from "./identity";

export type AuthTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export async function lockUserAdministration(tx: AuthTransaction) {
  // Shared with the development approval command, for consistent admin mutations.
  await tx.execute(sql`select pg_advisory_xact_lock(73429101)`);
}

export async function bootstrapAdmin(
  tx: AuthTransaction,
  user: AppUser,
  configuredEmails: string,
) {
  if (!isSuperAdminEmail(user.email, configuredEmails)) return user;
  if (!user.googleId || !user.emailVerified) throw new Error("Bootstrap requires a verified linked Google identity");
  if (user.status === "APPROVED" && user.role === "ADMIN") return user;

  const [updated] = await tx.update(users).set({
    status: "APPROVED",
    role: "ADMIN",
    approvedAt: user.status === "APPROVED" ? user.approvedAt : new Date(),
    approvedBy: user.status === "APPROVED" ? user.approvedBy : null,
    updatedAt: new Date(),
  }).where(eq(users.id, user.id)).returning();

  const changes: (typeof auditLogs.$inferInsert)[] = [];
  if (user.status !== "APPROVED") changes.push({
    userId: user.id, action: "USER_APPROVED", targetId: user.id,
    metadata: { reason: "SUPER_ADMIN_EMAILS", previousStatus: user.status },
  });
  if (user.role !== "ADMIN") changes.push({
    userId: user.id, action: "ROLE_CHANGED", targetId: user.id,
    metadata: { reason: "SUPER_ADMIN_EMAILS", previousRole: user.role, role: "ADMIN" },
  });
  if (changes.length) await tx.insert(auditLogs).values(changes);
  return updated;
}

/** Runs before Auth.js creates or reuses a session. The verified Google profile is the only identity source. */
export async function synchronizeGoogleLogin(
  db: Database,
  identity: GoogleIdentity,
  account: { provider: string; providerAccountId: string; type: string },
  configuredEmails: string,
) {
  assertGoogleAccount(account, identity);
  return db.transaction(async (tx) => {
    await lockUserAdministration(tx);
    const [linked] = await tx.select({ user: users }).from(accounts)
      .innerJoin(users, eq(accounts.userId, users.id))
      .where(and(eq(accounts.provider, "google"), eq(accounts.providerAccountId, identity.googleId)))
      .limit(1);
    const identityOwners = await tx.select().from(users)
      .where(or(eq(users.email, identity.email), eq(users.googleId, identity.googleId)));
    if (identityOwners.some((owner) => owner.id !== linked?.user.id)) {
      // Never silently merge accounts by email, including partially linked accounts.
      throw new Error("Google account conflicts with an existing user");
    }
    if (!linked) return;
    assertIdentityMatches(identity, linked.user);
    if (!linked.user.googleId || !linked.user.emailVerified) throw new Error("Google account linkage is incomplete");
    const [updated] = await tx.update(users).set({
      email: identity.email,
      name: identity.name,
      image: identity.image,
      emailVerified: new Date(),
      updatedAt: new Date(),
    }).where(eq(users.id, linked.user.id)).returning();
    await bootstrapAdmin(tx, updated, configuredEmails);
  });
}
