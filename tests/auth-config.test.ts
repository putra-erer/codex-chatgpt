import type { NextAuthConfig, Session } from "next-auth";
import type { GoogleIdentity } from "@/server/auth/identity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  synchronize: vi.fn(),
  adapter: vi.fn((_db: unknown, _emails: string, _identity: () => unknown) => ({})),
}));
vi.mock("@/server/db", () => ({ getDb: () => ({}) }));
vi.mock("@/server/auth/adapter", () => ({ createPortalAdapter: mocks.adapter }));
vi.mock("@/server/auth/service", () => ({ synchronizeGoogleLogin: mocks.synchronize }));

import { createAuthConfig } from "@/auth";

type SignInInput = Parameters<NonNullable<NonNullable<NextAuthConfig["callbacks"]>["signIn"]>>[0];
type SessionInput = Parameters<NonNullable<NonNullable<NextAuthConfig["callbacks"]>["session"]>>[0];

describe("Auth.js request callbacks", () => {
  const input: SignInInput = {
    user: { id: "local-user", email: "user@company.com" },
    account: { provider: "google", providerAccountId: "google-123", type: "oidc" },
    profile: { sub: "google-123", email: "user@company.com", email_verified: true, name: "User" },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.synchronize.mockResolvedValue(undefined);
    vi.stubEnv("DATABASE_URL", "postgresql://app:test@localhost/portal");
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    vi.stubEnv("AUTH_SECRET", "test-only-secret-at-least-32-characters");
    vi.stubEnv("GOOGLE_CLIENT_ID", "example-client");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "example-secret");
    vi.stubEnv("SUPER_ADMIN_EMAILS", "admin@company.com");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("keeps verified profiles isolated between requests", async () => {
    const first = createAuthConfig();
    createAuthConfig();
    const firstIdentity = mocks.adapter.mock.calls[0][2] as () => GoogleIdentity | undefined;
    const secondIdentity = mocks.adapter.mock.calls[1][2] as () => GoogleIdentity | undefined;
    expect(firstIdentity()).toBeUndefined();
    expect(secondIdentity()).toBeUndefined();
    await expect(first.callbacks!.signIn!(input)).resolves.toBe(true);
    expect(firstIdentity()?.googleId).toBe("google-123");
    expect(secondIdentity()).toBeUndefined();
  });

  it("fails closed on verification or database conflict and clears the verified context", async () => {
    const config = createAuthConfig();
    const getIdentity = mocks.adapter.mock.calls[0][2];
    await expect(config.callbacks!.signIn!(input)).resolves.toBe(true);
    mocks.synchronize.mockRejectedValue(new Error("Database identity collision"));
    await expect(config.callbacks!.signIn!(input)).resolves.toBe(false);
    expect(getIdentity()).toBeUndefined();
  });

  it("rejects an unverified profile before it can reach identity synchronization", async () => {
    const config = createAuthConfig();
    await expect(config.callbacks!.signIn!({ ...input, profile: { ...input.profile, email_verified: false } })).resolves.toBe(false);
    expect(mocks.synchronize).not.toHaveBeenCalled();
    expect(mocks.adapter.mock.calls[0][2]()).toBeUndefined();
  });

  it("does not enable a credentials provider or JWT sessions", () => {
    const config = createAuthConfig();
    expect(config.providers).toHaveLength(1);
    expect(config.providers[0]).toMatchObject({ id: "google" });
    expect(config.session?.strategy).toBe("database");
  });

  it("replaces client session role/status with current adapter user values", async () => {
    const config = createAuthConfig();
    const session = {
      user: { id: "user-1", role: "ADMIN", status: "APPROVED" },
      expires: new Date(Date.now() + 60000).toISOString(),
    } as Session;
    const result = await config.callbacks!.session!({
      session,
      user: { id: "user-1", email: "user@company.com", emailVerified: new Date(), role: "VIEWER", status: "REJECTED" },
      newSession: { role: "ADMIN", status: "APPROVED" },
      trigger: "update",
    } as SessionInput);
    expect(result.user).toMatchObject({ id: "user-1", role: "VIEWER", status: "REJECTED" });
  });

  it("routes callbacks through the configured origin for a fresh server approval check", async () => {
    const config = createAuthConfig();
    await expect(config.callbacks!.redirect!({ url: "https://attacker.test/admin", baseUrl: "https://untrusted.example" }))
      .resolves.toBe("http://localhost:3000/login");
  });
});
