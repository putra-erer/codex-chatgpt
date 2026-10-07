import "server-only";
import { and, eq, gt, isNotNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "@/server/db";
import { accounts, sessions, userPresence, users } from "@/server/db/schema";

export const presenceTimeoutSeconds = 60;
const activeSession = alias(sessions, "active_session");

/** userId and sessionToken come from the authenticated server; tabId identifies a tab within that session. */
async function updatePresence(
  db: Database,
  userId: string,
  sessionToken: string,
  tabId: string,
  action: "heartbeat" | "leave",
) {
  if (!z.uuid().safeParse(userId).success || !z.uuid().safeParse(tabId).success || !sessionToken) return false;
  return db.transaction(async (tx) => {
    // Serialize with logout/session deletion so a heartbeat cannot recreate logged-out presence.
    const [session] = await tx.select({ token: activeSession.sessionToken }).from(activeSession)
      .innerJoin(users, eq(users.id, activeSession.userId))
      .innerJoin(accounts, and(
        eq(accounts.userId, users.id), eq(accounts.provider, "google"),
        eq(accounts.providerAccountId, users.googleId),
      ))
      .where(and(
        eq(activeSession.sessionToken, sessionToken), eq(activeSession.userId, userId),
        gt(activeSession.expires, sql`now()`), eq(users.status, "APPROVED"), isNotNull(users.emailVerified),
      )).limit(1).for("update", { of: activeSession });
    if (!session) return false;

    if (action === "leave") {
      await tx.delete(userPresence).where(and(
        eq(userPresence.sessionToken, sessionToken), eq(userPresence.tabId, tabId),
      ));
      return true;
    }

    // Closed/crashed tabs age out. Never clear a different login session's records.
    await tx.delete(userPresence).where(and(
      eq(userPresence.sessionToken, sessionToken),
      lt(userPresence.lastSeen, sql`now() - ${presenceTimeoutSeconds} * interval '1 second'`),
    ));
    await tx.insert(userPresence).values({ sessionToken, tabId, lastSeen: sql`now()` })
      .onConflictDoUpdate({
        target: [userPresence.sessionToken, userPresence.tabId],
        set: { lastSeen: sql`now()` },
      });
    return true;
  });
}

export async function heartbeat(db: Database, userId: string, sessionToken: string, tabId: string) {
  return updatePresence(db, userId, sessionToken, tabId, "heartbeat");
}

export async function leave(db: Database, userId: string, sessionToken: string, tabId: string) {
  return updatePresence(db, userId, sessionToken, tabId, "leave");
}
