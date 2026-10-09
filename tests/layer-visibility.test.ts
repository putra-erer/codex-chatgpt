import { describe, expect, it } from "vitest";
import { parseVisibilityOverrides, visibilityStorageKey } from "@/components/layers/visibility-state";

const first = "b8f021a7-c31a-4b22-946c-559c86af93bd";
const second = "c8f021a7-c31a-4b22-946c-559c86af93bd";

describe("local layer visibility preferences", () => {
  it("preserves both hidden and visible overrides without coercing untrusted values", () => {
    expect(parseVisibilityOverrides(JSON.stringify({ [first]: false, [second]: true })))
      .toEqual({ [first]: false, [second]: true });
    for (const value of ["false", 0, 1, null, [], {}]) {
      expect(parseVisibilityOverrides(JSON.stringify({ [first]: value, [second]: false })))
        .toEqual({ [second]: false });
    }
  });

  it("ignores malformed, non-object and oversized browser storage", () => {
    for (const raw of [null, "", "broken", "null", "true", "[]", "1", JSON.stringify("x".repeat(300_000))]) {
      expect(parseVisibilityOverrides(raw)).toEqual({});
    }
  });

  it("ignores prototype keys and invalid layer identifiers", () => {
    const raw = `{"__proto__":true,"constructor":false,"not-a-layer":true,"${first}":false}`;
    const preferences = parseVisibilityOverrides(raw);
    expect(Object.keys(preferences)).toEqual([first]);
    expect(preferences[first]).toBe(false);
    expect(Object.getPrototypeOf(preferences)).toBe(Object.prototype);
  });

  it("separates preferences for different signed-in users", () => {
    expect(visibilityStorageKey(first)).not.toBe(visibilityStorageKey(second));
  });
});
