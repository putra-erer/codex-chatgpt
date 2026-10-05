import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { and, eq } from "drizzle-orm";
import type { Adapter, AdapterAccount, AdapterUser } from "next-auth/adapters";
import type { Database } from "../db";
import { accounts, sessions, users } from "../db/schema";
import { assertGoogleAccount, type GoogleIdentity } from "./identity";
import { bootstrapAdmin, lockUserAdministration } from "./service";

/** Retain provider identity only; the portal never calls Google APIs on a user's behalf. */
export function identityAccount(account: AdapterAccount): AdapterAccount {
  assertGoogleAccount(account);
  return {
    userId: account.userId,
    provider: account.provider,
    providerAccountId: account.providerAccountId,
    type: account.type,
  };
}

export function createPortalAdapter(
  db: Database,
  configuredEmails: string,
  getVerifiedIdentity: () => GoogleIdentity | undefined,
): Adapter {
  const base = DrizzleAdapter(db, { usersTable: users, accountsTable: accounts, sessionsTable: sessions });

  return {
    ...base,
    async createUser(data) {
      const identity = getVerifiedIdentity();
      if (!identity || data.email?.trim().toLowerCase() !== identity.email) {
        throw new Error("Creating a user requires a verified Google email");
      }
      // Auth.js deliberately resets OAuth emailVerified to null before createUser.
      // Use only the verified profile captured in this request's signIn callback.
      const [created] = await db.insert(users).values({
        email: identity.email,
        emailVerified: new Date(),
        name: identity.name,
        image: identity.image,
        status: "PENDING",
        role: "VIEWER",
      }).returning();
      return created;
    },
    async getUserByEmail(email) {
      const [user] = await db.select().from(users).where(eq(users.email, email.trim().toLowerCase())).limit(1);
      return user ?? null;
    },
    async updateUser(data) {
      // OAuth profile synchronization occurs in synchronizeGoogleLogin after verification.
      // Do not let adapter callers change authorization or relink an email.
      const [existing] = await db.select().from(users).where(eq(users.id, data.id)).limit(1);
      if (!existing || (data.email && data.email.trim().toLowerCase() !== existing.email)) {
        throw new Error("Invalid adapter user update");
      }
      const changes: Partial<AdapterUser> = {};
      if (data.name !== undefined) changes.name = data.name;
      if (data.image !== undefined) changes.image = data.image;
      const [updated] = await db.update(users).set({ ...changes, updatedAt: new Date() })
        .where(eq(users.id, data.id)).returning();
      return updated;
    },
    async linkAccount(account) {
      const safeAccount = identityAccount(account);
      const identity = getVerifiedIdentity();
      if (!identity) throw new Error("Cannot link an account without a verified Google profile");
      assertGoogleAccount(safeAccount, identity);
      return db.transaction(async (tx) => {
        await lockUserAdministration(tx);
        const [user] = await tx.select().from(users).where(eq(users.id, safeAccount.userId)).limit(1);
        if (!user?.emailVerified || user.email !== identity.email
          || (user.googleId && user.googleId !== safeAccount.providerAccountId)) {
          throw new Error("Cannot link an unverified or conflicting Google identity");
        }
        await tx.insert(accounts).values(safeAccount);
        const [updated] = await tx.update(users).set({ googleId: safeAccount.providerAccountId, updatedAt: new Date() })
          .where(eq(users.id, safeAccount.userId)).returning();
        await bootstrapAdmin(tx, updated, configuredEmails);
        return safeAccount;
      });
    },
    async createSession(session) {
      const verifiedIdentity = getVerifiedIdentity();
      if (!verifiedIdentity) throw new Error("Cannot create a session without a verified Google profile");
      return db.transaction(async (tx) => {
        const [identity] = await tx.select({ user: users, account: accounts }).from(users)
          .innerJoin(accounts, and(eq(accounts.userId, users.id), eq(accounts.provider, "google")))
          .where(eq(users.id, session.userId)).limit(1);
        if (!identity?.user.emailVerified || !identity.user.googleId
          || identity.user.googleId !== identity.account.providerAccountId
          || identity.user.googleId !== verifiedIdentity.googleId
          || identity.user.email !== verifiedIdentity.email) {
          throw new Error("Cannot create a session before Google identity linkage is complete");
        }
        const [created] = await tx.insert(sessions).values(session).returning();
        return created;
      });
    },
    async getSessionAndUser(sessionToken) {
      const [result] = await db.select({ user: users, session: sessions, account: accounts }).from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .innerJoin(accounts, and(eq(accounts.userId, users.id), eq(accounts.provider, "google")))
        .where(eq(sessions.sessionToken, sessionToken)).limit(1);
      if (!result?.user.emailVerified || !result.user.googleId
        || result.user.googleId !== result.account.providerAccountId) return null;
      return { user: result.user, session: result.session };
    },
  };
}
