import { describe, expect, it } from "vitest";
import { assertGoogleAccount, assertIdentityMatches, isSuperAdminEmail, parseGoogleIdentity } from "@/server/auth/identity";
import { parseConfig } from "@/server/config";

describe("verified Google identity", () => {
  const profile = { sub: "google-123", email: " User@Company.com ", email_verified: true, name: "User" };

  it("normalizes verified email and retains the stable Google subject", () => {
    expect(parseGoogleIdentity(profile)).toEqual({ googleId: "google-123", email: "user@company.com", name: "User", image: null });
  });

  it.each([false, undefined, "true", 1])("rejects email_verified=%s", (email_verified) => {
    expect(() => parseGoogleIdentity({ ...profile, email_verified })).toThrow();
  });

  it.each([{ sub: "" }, { sub: undefined }, { email: "not-an-email" }])("rejects invalid identity %j", (overrides) => {
    expect(() => parseGoogleIdentity({ ...profile, ...overrides })).toThrow();
  });

  it("accepts only exact normalized bootstrap email matches", () => {
    const configured = " Admin@Company.com, second@company.com ";
    expect(isSuperAdminEmail("admin@company.com", configured)).toBe(true);
    expect(isSuperAdminEmail("SECOND@company.com", configured)).toBe(true);
    expect(isSuperAdminEmail("not-admin@company.com", configured)).toBe(false);
    expect(isSuperAdminEmail("admin@company.com.attacker.test", configured)).toBe(false);
    expect(isSuperAdminEmail("admin@company.com", "*@company.com")).toBe(false);
    expect(isSuperAdminEmail("admin@company.com", "")).toBe(false);
  });

  it("rejects a conflicting subject even with a matching email", () => {
    expect(() => assertIdentityMatches(parseGoogleIdentity(profile), { googleId: "other-account", email: "user@company.com" })).toThrow();
  });

  it("rejects non-Google providers and mismatched account subjects", () => {
    const identity = parseGoogleIdentity(profile);
    expect(() => assertGoogleAccount({ provider: "github", providerAccountId: identity.googleId, type: "oauth" }, identity)).toThrow();
    expect(() => assertGoogleAccount({ provider: "google", providerAccountId: "wrong", type: "oidc" }, identity)).toThrow();
    expect(() => assertGoogleAccount({ provider: "google", providerAccountId: identity.googleId, type: "credentials" }, identity)).toThrow();
  });
});

describe("runtime configuration", () => {
  const env = {
    DATABASE_URL: "postgresql://app:test@localhost:5432/portal",
    AUTH_URL: "http://localhost:3000",
    AUTH_SECRET: "test-only-secret-that-is-at-least-32-characters",
    GOOGLE_CLIENT_ID: "example-client", GOOGLE_CLIENT_SECRET: "example-secret",
  };

  it("allows unrelated variables and optional empty bootstrap list", () => {
    expect(parseConfig({ ...env, UNRELATED: "value" }).SUPER_ADMIN_EMAILS).toBe("");
  });

  it.each(["https://portal.example/path", "https://portal.example?query=yes", "ftp://portal.example", "https://user:password@portal.example"])("rejects invalid AUTH_URL %s", (AUTH_URL) => {
    expect(() => parseConfig({ ...env, AUTH_URL })).toThrow("AUTH_URL");
  });

  it("reports only setting names without revealing invalid values", () => {
    expect(() => parseConfig({ ...env, AUTH_SECRET: "sensitive" })).toThrow(/^Missing or invalid environment configuration: AUTH_SECRET$/);
  });
});
