import type { ExpressionSpecification } from "maplibre-gl";
import { z } from "zod";
import type { Bounds, GeometryType } from "@/lib/gis/types";

// Keep attribute pickers, labels, and feature popups on the same public-field policy.
const reservedField = /^(?:_.*|geom(?:etry)?|wkb_geometry|ogc_fid|gid|fid|feature_id|table_name|file_path|storage_metadata|uploaded_by|source_srid|source_crs_wkt|constructor|prototype|.*(?:password|secret|token|credential|connection_string).*)$/i;
export function isDisplayField(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && name.length <= 100
    && name.trim() === name && !/[\u0000-\u001f\u007f]/.test(name) && !reservedField.test(name);
}

const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex color.");
const opacitySchema = z.number().finite().min(0).max(1);
const zoomSchema = z.number().finite().min(0).max(24);
const fieldSchema = z.string().min(1).max(100).refine(isDisplayField, "Choose a displayable attribute field.");
const categoryValueSchema = z.union([
  z.string().max(200).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Category values cannot contain control characters."),
  z.number().finite(),
  z.boolean(),
]);
const categorySchema = z.object({
  field: fieldSchema,
  categories: z.array(z.object({ value: categoryValueSchema, color: colorSchema }).strict()).min(1).max(50),
  otherColor: colorSchema,
}).strict().superRefine((category, context) => {
  const values = new Set<string>();
  for (let index = 0; index < category.categories.length; index++) {
    const value = category.categories[index].value;
    const key = `${typeof value}:${JSON.stringify(value)}`;
    if (values.has(key)) context.addIssue({ code: "custom", path: ["categories", index, "value"], message: "Category values must be unique." });
    values.add(key);
  }
});
const labelSchema = z.object({
  enabled: z.boolean(),
  field: fieldSchema.nullable(),
  size: z.number().finite().min(8).max(48),
  color: colorSchema,
  haloColor: colorSchema,
  haloWidth: z.number().finite().min(0).max(8),
  minZoom: zoomSchema,
  maxZoom: zoomSchema,
}).strict().superRefine((label, context) => {
  if (label.enabled && label.field === null) context.addIssue({ code: "custom", path: ["field"], message: "Select an attribute before enabling labels." });
  if (label.minZoom > label.maxZoom) context.addIssue({ code: "custom", path: ["maxZoom"], message: "Maximum label zoom must be at least the minimum zoom." });
});

/** The only accepted write format. Arbitrary MapLibre properties/expressions are not accepted. */
export const vectorStyleSchema = z.object({
  version: z.literal(1),
  type: z.enum(["polygon", "line", "point"]),
  mode: z.enum(["single", "categorized"]),
  color: colorSchema,
  opacity: opacitySchema,
  width: z.number().finite().min(0.5).max(20),
  radius: z.number().finite().min(1).max(40),
  strokeColor: colorSchema,
  strokeWidth: z.number().finite().min(0).max(12),
  strokeOpacity: opacitySchema,
  dash: z.enum(["solid", "dashed", "dotted"]),
  category: categorySchema.nullable(),
  label: labelSchema,
  minZoom: zoomSchema,
  maxZoom: zoomSchema,
}).strict().superRefine((style, context) => {
  if ((style.mode === "categorized") !== (style.category !== null)) {
    context.addIssue({ code: "custom", path: ["category"], message: "Categorized styles require categories; single-symbol styles use no categories." });
  }
  if (style.minZoom > style.maxZoom) context.addIssue({ code: "custom", path: ["maxZoom"], message: "Maximum layer zoom must be at least the minimum zoom." });
});
export type VectorStyle = z.infer<typeof vectorStyleSchema>;

function styleType(geometryType: GeometryType): VectorStyle["type"] {
  if (geometryType === "Point" || geometryType === "MultiPoint") return "point";
  if (geometryType === "LineString" || geometryType === "MultiLineString") return "line";
  return "polygon";
}

export function defaultVectorStyle(geometryType: GeometryType): VectorStyle {
  const type = styleType(geometryType);
  return {
    version: 1, type, mode: "single",
    color: type === "polygon" ? "#2F6B45" : type === "line" ? "#337AB7" : "#E39A35",
    opacity: type === "polygon" ? 0.4 : 1, width: 2, radius: 6,
    strokeColor: type === "point" ? "#FFFFFF" : "#163A2B", strokeWidth: 1, strokeOpacity: 1,
    dash: "solid", category: null,
    label: { enabled: false, field: null, size: 12, color: "#163A2B", haloColor: "#FFFFFF", haloWidth: 1, minZoom: 12, maxZoom: 24 },
    minZoom: 0, maxZoom: 24,
  };
}

export function validateStyleForGeometry(raw: unknown, geometryType: GeometryType): VectorStyle {
  const style = vectorStyleSchema.parse(raw);
  if (style.type !== styleType(geometryType)) {
    throw new z.ZodError([{ code: "custom", path: ["type"], message: "The style type must match the layer geometry." }]);
  }
  return style;
}

/** Read compatibility for Phase 1–4 JSON. Never writes or modifies the stored value. */
export function normalizeVectorStyle(raw: unknown, geometryType: GeometryType): VectorStyle {
  const parsed = vectorStyleSchema.safeParse(raw);
  if (parsed.success && parsed.data.type === styleType(geometryType)) return parsed.data;
  const fallback = defaultVectorStyle(geometryType);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback;
  const legacy = raw as Record<string, unknown>;
  if (colorSchema.safeParse(legacy.color).success) {
    fallback.color = legacy.color as string;
    // Phase 4 polygons used their fill color as their outline color.
    if (fallback.type === "polygon") fallback.strokeColor = fallback.color;
  }
  const bounded = (value: unknown, min: number, max: number, defaultValue: number) =>
    typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : defaultValue;
  fallback.opacity = bounded(legacy.opacity, 0, 1, fallback.opacity);
  fallback.width = bounded(legacy.width, 0.5, 20, fallback.width);
  fallback.radius = bounded(legacy.radius, 1, 40, fallback.radius);
  // The previous viewer rendered points with an opaque 2px white stroke.
  if (fallback.type === "point") fallback.strokeWidth = 2;
  return fallback;
}

/** Equal min/max extents are valid for single points and axis-aligned lines. */
export function validBounds(value: unknown): value is Bounds {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((item) => typeof item === "number" && Number.isFinite(item))) return false;
  const [west, south, east, north] = value;
  return west >= -180 && east <= 180 && south >= -90 && north <= 90 && west <= east && south <= north;
}

export function categoryColorExpression(style: VectorStyle): string | ExpressionSpecification {
  if (style.mode !== "categorized" || !style.category) return style.color;
  const { field, categories, otherColor } = style.category;
  // `match` cannot mix string/number/boolean labels. A typed case also avoids
  // coercion (the number 1, the string "1", and true remain separate values).
  const expression: unknown[] = ["case"];
  for (const { value, color } of categories) {
    expression.push(["all", ["==", ["typeof", ["get", field]], typeof value], ["==", ["get", field], ["literal", value]]], color);
  }
  expression.push(otherColor);
  return expression as ExpressionSpecification;
}

export function legendEntries(style: VectorStyle, name: string): { label: string; color: string }[] {
  if (style.mode !== "categorized" || !style.category) return [{ label: name, color: style.color }];
  const { categories, otherColor } = style.category;
  return [
    ...categories.map(({ value, color }) => ({
      label: categories.filter((category) => String(category.value) === String(value)).length > 1
        ? `${String(value)} (${typeof value})` : String(value) || "(empty text)",
      color,
    })),
    { label: "Other / missing values", color: otherColor },
  ];
}
