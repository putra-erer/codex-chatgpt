import { describe, expect, it } from "vitest";
import { parseDevUserOptions } from "../scripts/dev-user-options";

describe("development user command boundary", () => {
  it("normalizes addresses and defaults to VIEWER", () => {
    expect(parseDevUserOptions(["--email", " User@Example.com ", "--status", "APPROVED", "--approved-by", "Admin@Example.com"]))
      .toEqual({ email: "user@example.com", actorEmail: "admin@example.com", status: "APPROVED", role: "VIEWER" });
  });
  it.each([
    ["--email", "user@example.com", "--status", "APPROVED"],
    ["--email", "user@example.com", "--status", "ROOT", "--approved-by", "admin@example.com"],
    ["--email", "user@example.com", "--status", "PENDING", "--role", "ADMIN", "--approved-by", "admin@example.com"],
    ["--email", "user@example.com", "--status", "APPROVED", "--approved-by", "admin@example.com", "--sql", "DROP TABLE app.users"],
    ["--email", "user@example.com", "--status", "APPROVED", "--approved-by", "admin@example.com", "--role", "VIEWER", "--role", "ADMIN"],
  ])("rejects incomplete, unsupported, or ambiguous input: %j", (...args) => {
    expect(() => parseDevUserOptions(args)).toThrow();
  });
});
