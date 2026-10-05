import { beforeEach, describe, expect, it, vi } from "vitest";
import { canAccessAdmin, canAccessMap, landingPath } from "@/server/authorization/policy";
import type { AppUser, UserRole, UserStatus } from "@/server/db/schema";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), limit: vi.fn(), redirect: vi.fn((path: string) => { throw new Error(`REDIRECT:${path}`); }) }));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/server/db", () => ({
  getDb: () => ({ select: () => ({ from: () => ({ where: () => ({ limit: mocks.limit }) }) }) }),
}));

import { getCurrentUser, requireAdmin, requireApprovedUser, requireUser } from "@/server/authorization/guards";

describe("approval and role matrix", () => {
  const cases: [UserStatus, UserRole, string, boolean, boolean][] = [
    ["PENDING", "VIEWER", "/pending", false, false],
    ["PENDING", "ADMIN", "/pending", false, false],
    ["REJECTED", "VIEWER", "/access-denied", false, false],
    ["REJECTED", "ADMIN", "/access-denied", false, false],
    ["APPROVED", "VIEWER", "/map", true, false],
    ["APPROVED", "ADMIN", "/map", true, true],
  ];
  it.each(cases)("%s %s routes and privileges", (status, role, path, map, admin) => {
    const user = { status, role };
    expect(landingPath(user)).toBe(path);
    expect(canAccessMap(user)).toBe(map);
    expect(canAccessAdmin(user)).toBe(admin);
  });
  it("denies anonymous access", () => {
    expect(canAccessMap(null)).toBe(false);
    expect(canAccessAdmin(undefined)).toBe(false);
  });
});

describe("server guards", () => {
  const user = { id: "user-1", email: "user@company.com", googleId: "google-1", emailVerified: new Date(), status: "APPROVED", role: "VIEWER" } as AppUser;

  beforeEach(() => {
    vi.clearAllMocks();
    // Stale session claims must never grant ADMIN access.
    mocks.auth.mockResolvedValue({ user: { id: "user-1", role: "ADMIN", status: "APPROVED" } });
    mocks.limit.mockResolvedValue([user]);
  });

  it("redirects an unauthenticated request to login", async () => {
    mocks.auth.mockResolvedValue(null);
    await expect(requireUser()).rejects.toThrow("REDIRECT:/login");
    expect(mocks.limit).not.toHaveBeenCalled();
  });

  it("reads current database roles and denies an approved viewer at /admin", async () => {
    await expect(requireAdmin()).rejects.toThrow("REDIRECT:/access-denied");
    expect(mocks.limit).toHaveBeenCalledOnce();
  });

  it.each([ ["PENDING", "/pending"], ["REJECTED", "/access-denied"] ])("blocks %s even if session says approved admin", async (status, path) => {
    mocks.limit.mockResolvedValue([{ ...user, status, role: "ADMIN" }]);
    await expect(requireApprovedUser()).rejects.toThrow(`REDIRECT:${path}`);
    await expect(requireAdmin()).rejects.toThrow(`REDIRECT:${path}`);
  });

  it("allows only an approved admin to pass the admin guard", async () => {
    const admin = { ...user, role: "ADMIN" };
    mocks.limit.mockResolvedValue([admin]);
    await expect(requireAdmin()).resolves.toEqual(admin);
  });

  it("allows an approved viewer to access the map", async () => {
    await expect(requireApprovedUser()).resolves.toEqual(user);
  });

  it.each([[], [{ ...user, googleId: null }], [{ ...user, emailVerified: null }]])("fails closed for deleted or incomplete identities", async (...result) => {
    mocks.limit.mockResolvedValue(result);
    await expect(getCurrentUser()).resolves.toBeNull();
  });
});
