import { afterEach, describe, expect, it, vi } from "vitest";
import { isPresenceOriginAllowed } from "@/server/presence/origin";

afterEach(() => vi.unstubAllEnvs());

describe("presence mutation origin validation", () => {
  const configured = "https://portal.example.test";

  it("accepts only the configured origin in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CODESPACES", "true");
    expect(isPresenceOriginAllowed(configured, configured)).toBe(true);
    for (const origin of [null, "null", "https://attacker.example", "http://localhost:3000",
      "https://portal.example.test.attacker.example", "https://portal.example.test:444"]) {
      expect(isPresenceOriginAllowed(origin, configured)).toBe(false);
    }
  });

  it("permits the exact Codespaces loopback origin only during development", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CODESPACES", "true");
    expect(isPresenceOriginAllowed("http://localhost:3000", configured)).toBe(true);
    expect(isPresenceOriginAllowed("http://localhost:3001", configured)).toBe(false);
    vi.stubEnv("CODESPACES", "false");
    expect(isPresenceOriginAllowed("http://localhost:3000", configured)).toBe(false);
  });
});
