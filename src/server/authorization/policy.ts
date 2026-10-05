import type { UserRole, UserStatus } from "../db/schema";

type AccessUser = { status: UserStatus; role: UserRole };

export function landingPath(user: AccessUser): "/pending" | "/access-denied" | "/map" {
  if (user.status === "PENDING") return "/pending";
  if (user.status === "REJECTED") return "/access-denied";
  return "/map";
}

export function canAccessMap(user: AccessUser | null | undefined) {
  return user?.status === "APPROVED";
}

export function canAccessAdmin(user: AccessUser | null | undefined) {
  return canAccessMap(user) && user?.role === "ADMIN";
}
