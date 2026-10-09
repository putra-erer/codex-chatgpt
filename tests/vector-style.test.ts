import { Color, createExpression, latest, type StylePropertySpecification } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";
import {
  categoryColorExpression,
  defaultVectorStyle,
  isDisplayField,
  legendEntries,
  normalizeVectorStyle,
  validBounds,
  validateStyleForGeometry,
  vectorStyleSchema,
  type VectorStyle,
} from "@/lib/gis/style";
import { geometryFamily, type GeometryType } from "@/lib/gis/types";

const geometryCases = [
  ["Point", "point", "Point"], ["MultiPoint", "point", "Point"],
  ["LineString", "line", "LineString"], ["MultiLineString", "line", "LineString"],
  ["Polygon", "polygon", "Polygon"], ["MultiPolygon", "polygon", "Polygon"],
] as const;

function categorized(): VectorStyle {
  return {
    ...defaultVectorStyle("Polygon"),
    mode: "categorized",
    category: {
      field: "land_use",
      categories: [
        { value: "Forest", color: "#163A2B" },
        { value: "1", color: "#112233" },
        { value: 1, color: "#334455" },
        { value: true, color: "#556677" },
        { value: false, color: "#778899" },
        { value: "", color: "#99AABB" },
      ],
      otherColor: "#CCDDEE",
    },
  };
}

describe("vector style schema", () => {
  it.each(geometryCases)("validates defaults and the matching style family for %s", (geometry, type, family) => {
    const style = defaultVectorStyle(geometry);
    expect(style.type).toBe(type);
    expect(geometryFamily(geometry)).toBe(family);
    expect(validateStyleForGeometry(style, geometry)).toEqual(style);
    for (const other of ["point", "line", "polygon"] as const) {
      if (other !== type) expect(() => validateStyleForGeometry({ ...style, type: other }, geometry)).toThrow(/geometry/);
    }
  });

  it.each([
    ["opacity", 0, 1], ["width", 0.5, 20], ["radius", 1, 40],
    ["strokeWidth", 0, 12], ["strokeOpacity", 0, 1], ["minZoom", 0, 24], ["maxZoom", 0, 24],
  ] as const)("accepts only finite, bounded numeric %s", (key, min, max) => {
    const style = defaultVectorStyle("Polygon");
    for (const value of [min, max]) expect(vectorStyleSchema.safeParse({ ...style, [key]: value }).success).toBe(true);
    for (const value of [min - 0.01, max + 0.01, NaN, Infinity, -Infinity, "1", null]) {
      expect(vectorStyleSchema.safeParse({ ...style, [key]: value }).success).toBe(false);
    }
  });

  it.each([
    ["size", 8, 48], ["haloWidth", 0, 8], ["minZoom", 0, 24], ["maxZoom", 0, 24],
  ] as const)("accepts only finite, bounded label %s", (key, min, max) => {
    const style = defaultVectorStyle("Polygon");
    style.label.minZoom = 0;
    for (const value of [min, max]) expect(vectorStyleSchema.safeParse({ ...style, label: { ...style.label, [key]: value } }).success).toBe(true);
    for (const value of [min - 0.01, max + 0.01, NaN, Infinity, "1", null]) {
      expect(vectorStyleSchema.safeParse({ ...style, label: { ...style.label, [key]: value } }).success).toBe(false);
    }
  });

  it("rejects arbitrary expressions, unknown keys, incomplete writes, and future versions", () => {
    const style = categorized();
    const invalid = [
      {}, null, [], { ...style, version: 2 }, { ...style, paint: { "fill-color": "red" } },
      { ...style, color: ["get", "injected"] }, { ...style, opacity: ["get", "injected"] },
      { ...style, category: { ...style.category, expression: ["get", "injected"] } },
      { ...style, category: { ...style.category, categories: [{ value: "Forest", color: "#123456", expression: ["get", "injected"] }] } },
      { ...style, label: { ...style.label, "text-field": ["get", "injected"] } },
    ];
    for (const value of invalid) expect(vectorStyleSchema.safeParse(value).success).toBe(false);
  });

  it("accepts only full hex colors everywhere", () => {
    const style = categorized();
    for (const color of ["red", "#123", "#12345678", "url(https://example.test)", "javascript:alert(1)", "#GG0000", " #123456", "#123456 "]) {
      for (const candidate of [
        { ...style, color }, { ...style, strokeColor: color },
        { ...style, label: { ...style.label, color } }, { ...style, label: { ...style.label, haloColor: color } },
        { ...style, category: { ...style.category, otherColor: color } },
        { ...style, category: { ...style.category, categories: [{ value: "Forest", color }] } },
      ]) expect(vectorStyleSchema.safeParse(candidate).success).toBe(false);
    }
    expect(vectorStyleSchema.safeParse({ ...style, color: "#aBcDeF" }).success).toBe(true);
  });

  it("validates layer and label zoom order independently and requires a field for enabled labels", () => {
    const style = defaultVectorStyle("Polygon");
    expect(vectorStyleSchema.safeParse({ ...style, minZoom: 13, maxZoom: 12 }).success).toBe(false);
    expect(vectorStyleSchema.safeParse({ ...style, label: { ...style.label, minZoom: 13, maxZoom: 12 } }).success).toBe(false);
    expect(vectorStyleSchema.safeParse({ ...style, minZoom: 12, maxZoom: 12 }).success).toBe(true);
    expect(vectorStyleSchema.safeParse({ ...style, label: { ...style.label, enabled: true } }).success).toBe(false);
    expect(vectorStyleSchema.safeParse({ ...style, label: { ...style.label, enabled: true, field: "block_code" } }).success).toBe(true);
  });

  it("keeps categorized and single-symbol mode unambiguous", () => {
    const style = categorized();
    expect(vectorStyleSchema.safeParse(style).success).toBe(true);
    expect(vectorStyleSchema.safeParse({ ...style, category: null }).success).toBe(false);
    expect(vectorStyleSchema.safeParse({ ...style, mode: "single" }).success).toBe(false);
    expect(vectorStyleSchema.safeParse({ ...style, mode: "graduated" }).success).toBe(false);
    expect(vectorStyleSchema.safeParse({ ...style, dash: "arbitrary" }).success).toBe(false);
    for (const dash of ["solid", "dashed", "dotted"]) expect(vectorStyleSchema.safeParse({ ...style, dash }).success).toBe(true);
  });

  it("limits category count and scalar value size, and rejects same-type duplicate categories", () => {
    const style = categorized();
    const entries = Array.from({ length: 50 }, (_, value) => ({ value, color: "#163A2B" }));
    expect(vectorStyleSchema.safeParse({ ...style, category: { ...style.category, categories: entries } }).success).toBe(true);
    for (const categories of [[], [...entries, { value: 50, color: "#163A2B" }], [entries[0], entries[0]], [
      { value: 0, color: "#163A2B" }, { value: -0, color: "#FFFFFF" },
    ]]) expect(vectorStyleSchema.safeParse({ ...style, category: { ...style.category, categories } }).success).toBe(false);
    for (const value of [null, undefined, {}, [], NaN, Infinity, "x".repeat(201), "bad\nvalue", "bad\u0000value"]) {
      expect(vectorStyleSchema.safeParse({ ...style, category: { ...style.category, categories: [{ value, color: "#163A2B" }] } }).success).toBe(false);
    }
    expect(vectorStyleSchema.safeParse({ ...style, category: { ...style.category, categories: [{ value: "x".repeat(200), color: "#163A2B" }] } }).success).toBe(true);
  });

  it("excludes sensitive/internal attribute names from both labels and categories", () => {
    const style = categorized();
    const rejected: unknown[] = [
      "", " ", "land_use ", "\tland_use", "abc\u0000def", "a".repeat(101), null, undefined, 1,
      "_private", "__proto__", "constructor", "prototype", "GEOMETRY", "wkb_geometry", "ogc_fid", "feature_id",
      "table_name", "file_path", "storage_metadata", "uploaded_by", "source_srid", "source_crs_wkt",
      "userPasswordHash", "SECRET_VALUE", "access_token_expiry", "db_credentials", "connection_string_backup",
    ];
    for (const field of rejected) {
      expect(isDisplayField(field)).toBe(false);
      expect(vectorStyleSchema.safeParse({ ...style, category: { ...style.category, field } }).success).toBe(false);
      expect(vectorStyleSchema.safeParse({ ...style, label: { ...style.label, enabled: true, field } }).success).toBe(false);
    }
    for (const field of ["block_code", "Land Use", "luas_ha", "名称", "a".repeat(100), "O'Reilly"]) {
      expect(isDisplayField(field)).toBe(true);
      expect(vectorStyleSchema.safeParse({ ...style, category: { ...style.category, field } }).success).toBe(true);
    }
  });
});

describe("stored vector style compatibility", () => {
  it.each(geometryCases)("returns a renderable fallback for absent/corrupted %s styles", (geometry) => {
    const corrupted: unknown[] = [undefined, null, false, 10, "invalid", [], {}, { version: 999 }, { color: "expression", opacity: NaN }];
    for (const raw of corrupted) {
      const normalized = normalizeVectorStyle(raw, geometry);
      expect(() => validateStyleForGeometry(normalized, geometry)).not.toThrow();
    }
  });

  it("preserves Phase 4 colors, opacity, and point outline without modifying the database value", () => {
    const legacy = { color: "#123abc", opacity: 0.35, width: 4, radius: 9 };
    const original = structuredClone(legacy);
    expect(normalizeVectorStyle(legacy, "Polygon")).toMatchObject({ color: "#123abc", strokeColor: "#123abc", opacity: 0.35 });
    expect(normalizeVectorStyle(legacy, "MultiLineString")).toMatchObject({ color: "#123abc", width: 4, opacity: 0.35 });
    expect(normalizeVectorStyle(legacy, "MultiPoint")).toMatchObject({ color: "#123abc", radius: 9, strokeColor: "#FFFFFF", strokeWidth: 2 });
    expect(legacy).toEqual(original);
  });

  it("bounds legacy numeric values and discards expressions or a mismatched geometry family", () => {
    const normalized = normalizeVectorStyle({ color: ["get", "color"], opacity: -1, width: 100, radius: -1 }, "Point");
    expect(normalized).toMatchObject({ type: "point", color: defaultVectorStyle("Point").color, opacity: 0, width: 20, radius: 1 });
    const mismatched = normalizeVectorStyle(categorized(), "LineString");
    expect(mismatched.type).toBe("line");
    expect(mismatched.mode).toBe("single");
    expect(mismatched.category).toBeNull();
    expect(vectorStyleSchema.safeParse(mismatched).success).toBe(true);
  });

  it("round-trips modern styles without losing categories or labels and returns independent defaults", () => {
    const style = categorized();
    style.label = { ...style.label, enabled: true, field: "block_code", size: 18 };
    expect(normalizeVectorStyle(JSON.parse(JSON.stringify(style)), "MultiPolygon")).toEqual(style);
    const first = defaultVectorStyle("Polygon");
    first.color = "#000000";
    first.label.size = 48;
    expect(defaultVectorStyle("Polygon").color).toBe("#2F6B45");
    expect(defaultVectorStyle("Polygon").label.size).toBe(12);
  });
});

describe("MapLibre category expressions and legends", () => {
  // Compile and execute with the installed MapLibre evaluator, including color
  // type checking. evaluateWithoutErrorHandling must not hide render errors.
  function evaluate(style: VectorStyle, properties: Record<string, unknown>, geometry: GeometryType = "Polygon") {
    const property = style.type === "point" ? latest.paint_circle["circle-color"]
      : style.type === "line" ? latest.paint_line["line-color"] : latest.paint_fill["fill-color"];
    const compiled = createExpression(categoryColorExpression(style), "test-color", property as StylePropertySpecification);
    if (compiled.result === "error") throw new Error(JSON.stringify(compiled.value));
    return compiled.value.evaluateWithoutErrorHandling({ zoom: 14 }, { type: geometry, properties }).toString();
  }
  const color = (hex: string) => Color.parse(hex)!.toString();

  it.each(geometryCases)("compiles and renders single colors and typed categories for %s", (geometry, type) => {
    const single = defaultVectorStyle(geometry);
    expect(evaluate(single, {}, geometry)).toBe(color(single.color));
    const style = { ...categorized(), type };
    for (const category of style.category!.categories) {
      expect(evaluate(style, { land_use: category.value }, geometry)).toBe(color(category.color));
    }
  });

  it("uses the fallback color for unknown, null, missing, array, and object attribute values", () => {
    const style = categorized();
    const fallback = color(style.category!.otherColor);
    for (const value of ["Other", 99, null, [], {}, ["Forest"]]) expect(evaluate(style, { land_use: value })).toBe(fallback);
    expect(evaluate(style, {})).toBe(fallback);
  });

  it("treats expression-like attribute names and category strings as literal data", () => {
    const style = categorized();
    style.category = {
      field: "name'); DROP TABLE app.layers; --",
      categories: [{ value: '["get","private"]', color: "#123456" }],
      otherColor: "#FFFFFF",
    };
    expect(vectorStyleSchema.safeParse(style).success).toBe(true);
    expect(evaluate(style, { [style.category.field]: '["get","private"]' })).toBe(color("#123456"));
    expect(evaluate(style, { private: '["get","private"]' })).toBe(color("#FFFFFF"));
  });

  it("renders the maximum category count and preserves the same order and colors in the legend", () => {
    const style = categorized();
    style.category!.categories = Array.from({ length: 50 }, (_, value) => ({ value, color: value % 2 ? "#123456" : "#654321" }));
    const legend = legendEntries(style, "Uploaded layer");
    expect(legend).toHaveLength(51);
    for (const [index, category] of style.category!.categories.entries()) {
      expect(evaluate(style, { land_use: category.value })).toBe(color(category.color));
      expect(legend[index]).toEqual({ label: String(category.value), color: category.color });
    }
    expect(legend.at(-1)).toEqual({ label: "Other / missing values", color: style.category!.otherColor });
  });

  it("distinguishes numeric/string categories in legends and names empty values", () => {
    expect(legendEntries(categorized(), "Uploaded layer")).toEqual([
      { label: "Forest", color: "#163A2B" },
      { label: "1 (string)", color: "#112233" },
      { label: "1 (number)", color: "#334455" },
      { label: "true", color: "#556677" },
      { label: "false", color: "#778899" },
      { label: "(empty text)", color: "#99AABB" },
      { label: "Other / missing values", color: "#CCDDEE" },
    ]);
    const single = defaultVectorStyle("Polygon");
    expect(legendEntries(single, "Estate boundary")).toEqual([{ label: "Estate boundary", color: single.color }]);
  });
});

describe("layer bounds", () => {
  it("allows valid point, axis-aligned line, polygon, and world extents", () => {
    for (const bounds of [[106.82, -6.2, 106.82, -6.2], [1, 2, 1, 3], [1, 2, 3, 2], [1, 2, 3, 4], [-180, -90, 180, 90]]) {
      expect(validBounds(bounds)).toBe(true);
    }
  });
  it("rejects invalid, inverted, out-of-world, or non-finite extents before fitting the map", () => {
    for (const bounds of [null, {}, [], [1, 2, 3], [1, 2, 3, 4, 5], [3, 2, 1, 4], [1, 4, 3, 2],
      [-181, -90, 180, 90], [-180, -91, 180, 90], [-180, -90, 181, 90], [-180, -90, 180, 91],
      [0, 0, NaN, 1], [0, 0, Infinity, 1], [0, 0, "1", 1]]) {
      expect(validBounds(bounds)).toBe(false);
    }
  });
});
