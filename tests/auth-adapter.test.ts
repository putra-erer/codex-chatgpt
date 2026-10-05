import type { AdapterAccount, AdapterUser } from "next-auth/adapters";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/server/db";
import { createPortalAdapter, identityAccount } from "@/server/auth/adapter";
import type { GoogleIdentity } from "@/server/auth/identity";

vi.mock("@auth/drizzle-adapter", () => ({ DrizzleAdapter: () => ({}) }));

describe("OAuth adapter boundaries", () => {
  const identity: GoogleIdentity = { googleId: "google-123", email: "user@company.com", name: "Verified name", image: null };
  let requestIdentity: GoogleIdentity | undefined;
  const returning = vi.fn();
  const values = vi.fn(() => ({ returning }));
  const insert = vi.fn(() => ({ values }));
  const db = { insert } as unknown as Database;
  const adapter = createPortalAdapter(db, "", () => requestIdentity);

  beforeEach(() => {
    vi.clearAllMocks();
    requestIdentity = undefined;
    returning.mockResolvedValue([{ id: "new-user", status: "PENDING", role: "VIEWER" }]);
  });

  it("rejects createUser without request verification even if caller provides emailVerified", async () => {
    await expect(adapter.createUser!({ email: identity.email, emailVerified: new Date() } as AdapterUser)).rejects.toThrow("verified Google email");
    expect(insert).not.toHaveBeenCalled();
  });

  it("supports Auth.js core's emailVerified:null override using request-local verification", async () => {
    requestIdentity = identity;
    await adapter.createUser!({ email: identity.email, emailVerified: null, role: "ADMIN", status: "APPROVED", name: "Forged" } as AdapterUser);
    expect(values).toHaveBeenCalledWith({
      email: identity.email, emailVerified: expect.any(Date), name: "Verified name", image: null,
      role: "VIEWER", status: "PENDING",
    });
  });

  it("rejects a createUser email differing from the verified Google profile", async () => {
    requestIdentity = identity;
    await expect(adapter.createUser!({ email: "other@company.com", emailVerified: null } as AdapterUser)).rejects.toThrow();
    expect(insert).not.toHaveBeenCalled();
  });

  it("requires request verification to link an account or issue a session", async () => {
    await expect(adapter.linkAccount!({ provider: "google", providerAccountId: identity.googleId, userId: "user-1", type: "oidc" })).rejects.toThrow();
    await expect(adapter.createSession!({ userId: "user-1", sessionToken: "opaque", expires: new Date() })).rejects.toThrow();
  });

  it("rejects linking a provider subject different from the verified request", async () => {
    requestIdentity = identity;
    await expect(adapter.linkAccount!({ provider: "google", providerAccountId: "other-google", userId: "user-1", type: "oidc" })).rejects.toThrow();
  });

  it("discards OAuth access, refresh, and ID tokens", () => {
    const account: AdapterAccount = {
      provider: "google", providerAccountId: "google-123", userId: "user-1", type: "oidc",
      access_token: "secret-access", refresh_token: "secret-refresh", id_token: "secret-id",
      scope: "openid email profile", expires_at: 999999,
    };
    expect(identityAccount(account)).toEqual({ provider: "google", providerAccountId: "google-123", userId: "user-1", type: "oidc" });
  });
});
