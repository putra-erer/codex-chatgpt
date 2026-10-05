import "server-only";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getDb } from "@/server/db";
import { users } from "@/server/db/schema";
import { canAccessAdmin, landingPath } from "./policy";

export async function getCurrentUser() {
  const session = await auth();
  if (!session?.user?.id) return null;
  const [user] = await getDb().select().from(users).where(eq(users.id, session.user.id)).limit(1);
  if (!user?.googleId || !user.emailVerified) return null;
  return user;
}

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireApprovedUser() {
  const user = await requireUser();
  if (user.status !== "APPROVED") redirect(landingPath(user));
  return user;
}

export async function requireAdmin() {
  const user = await requireApprovedUser();
  if (!canAccessAdmin(user)) redirect("/access-denied");
  return user;
}
