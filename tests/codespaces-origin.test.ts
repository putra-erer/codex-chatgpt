import { isCsrfOriginAllowed } from "next/dist/server/app-render/csrf-protection";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());

async function loadOrigins(mode: "development" | "production" | "test", codespaces?: string) {
  vi.stubEnv("NODE_ENV", mode);
  vi.stubEnv("CODESPACES", codespaces);
  vi.resetModules();
  const { default: config } = await import("../next.config");
  return config.experimental?.serverActions?.allowedOrigins;
}

describe("Codespaces forwarded Server Action origin", () => {
  it("accepts the exact loopback origin observed through Codespaces in development", async () => {
    const origins = await loadOrigins("development", "true");
    expect(isCsrfOriginAllowed("localhost:3000", origins)).toBe(true);
  });

  it.each([
    "attacker.example",
    "localhost:3001",
    "localhost:3000.attacker.example",
    "another-codespace.app.github.dev",
  ])("continues to reject an unrelated origin: %s", async (origin) => {
    const origins = await loadOrigins("development", "true");
    expect(isCsrfOriginAllowed(origin, origins)).toBe(false);
  });

  it.each([
    { mode: "development" as const, codespaces: undefined },
    { mode: "development" as const, codespaces: "false" },
    { mode: "production" as const, codespaces: "true" },
    { mode: "test" as const, codespaces: "true" },
  ])("does not allow the proxy mismatch in $mode with CODESPACES=$codespaces", async ({ mode, codespaces }) => {
    const origins = await loadOrigins(mode, codespaces);
    expect(isCsrfOriginAllowed("localhost:3000", origins)).toBe(false);
  });
});
