import { describe, expect, it } from "vitest";
import { changeSchema, userFilters, usersUrl } from "@/lib/users/management";

describe("user management inputs", () => {
  it("normalizes malformed filters and bounds pagination/search", () => {
    expect(
      userFilters({
        status: ["APPROVED"],
        role: "OWNER",
        page: "-1",
        q: ["x"],
      }),
    ).toEqual({ status: "ALL", role: "ALL", page: 1, q: "" });
    expect(userFilters({ page: "1e20", q: "x".repeat(120) }).q).toHaveLength(
      100,
    );
    expect(userFilters({ page: "1000001" }).page).toBe(1000000);
  });
  it.each(["OWNER", "", null, "VIEWER,ADMIN"])(
    "rejects malformed role %s",
    (role) => {
      expect(
        changeSchema.safeParse({
          action: "role",
          userId: "11111111-1111-4111-8111-111111111111",
          version: "v1",
          role,
        }).success,
      ).toBe(false);
    },
  );
  it("encodes redirects as a local path without accepting arbitrary return URLs", () => {
    const url = usersUrl(
      userFilters({ q: "https://evil.example/?x=1&role=ADMIN" }),
      "approved",
    );
    expect(url.startsWith("/admin/users?")).toBe(true);
    expect(
      new URL(url, "https://portal.example").searchParams.get("role"),
    ).toBe("ALL");
  });
});
