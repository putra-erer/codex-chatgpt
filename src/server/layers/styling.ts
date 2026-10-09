import "server-only";
import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { MapLayer } from "@/lib/gis/types";
import { isDisplayField, validateStyleForGeometry, type VectorStyle } from "@/lib/gis/style";
import type { AuthTransaction } from "@/server/auth/service";
import type { Database } from "@/server/db";
import { auditLogs, layers } from "@/server/db/schema";
import { actorGuard, listAdminLayers, managed, supportedGeometry } from "@/server/layers/management";
import { GISProcessingError } from "@/server/processing/errors";
import { mapLayerDto, mapLayerFields } from "@/services/layers/catalog";

export const attributeLimits = { features: 10_000, fields: 100, categories: 50, timeoutMs: 3_000 } as const;
type Scalar = string | number | boolean;
type Layer = typeof layers.$inferSelect;
const groupName = z.string().trim().min(1).max(100).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const settingsSchema = z.object({ groupName: groupName.nullable(), defaultVisible: z.boolean() }).strict();
const orderSchema = z.object({ layerId: z.uuid(), direction: z.enum(["up", "down"]) }).strict();
const renameSchema = z.object({ from: groupName, to: groupName }).strict();
const styleEnvelope = z.object({ style: z.unknown() }).strict();

function assertId(value: string) {
  if (!z.uuid().safeParse(value).success) throw new GISProcessingError("INVALID_ID");
}
function queryTimedOut(error: unknown) {
  for (let depth = 0; error && typeof error === "object" && depth < 5; depth++) {
    if ("code" in error && error.code === "57014") return true;
    error = "cause" in error ? error.cause : undefined;
  }
  return false;
}
async function transaction<T>(db: Database, actorId: string, action: (tx: AuthTransaction) => Promise<T>): Promise<T> {
  assertId(actorId);
  try {
    return await db.transaction(async (tx) => {
      // Also bounds waiting for authorization/queue locks under concurrent administration.
      await tx.execute(sql`SELECT set_config('statement_timeout', ${String(attributeLimits.timeoutMs)}, true)`);
      await actorGuard(tx, actorId);
      return action(tx);
    });
  } catch (error) {
    if (queryTimedOut(error)) throw new GISProcessingError("ATTRIBUTE_QUERY_TIMEOUT");
    throw error;
  }
}
async function registeredLayer(tx: AuthTransaction, layerId: string, ready = true): Promise<Layer> {
  assertId(layerId);
  const [row] = await tx.select().from(layers).where(eq(layers.id, layerId)).for("update");
  if (!row) throw new GISProcessingError("NOT_FOUND");
  if (!managed(row)) throw new GISProcessingError("NOT_MANAGED");
  if (row.state === "DELETING" || (ready && row.state !== "READY")) throw new GISProcessingError("LAYER_BUSY");
  if (ready && !supportedGeometry(row.geometryType)) throw new GISProcessingError("UNSUPPORTED_GEOMETRY");
  return row;
}
async function layerDto(tx: AuthTransaction, layerId: string): Promise<MapLayer> {
  const [row] = await tx.select(mapLayerFields).from(layers).where(eq(layers.id, layerId));
  if (!row) throw new GISProcessingError("NOT_FOUND");
  return mapLayerDto(row);
}
function sourceTable(row: Layer) {
  // The UUID-derived identifier must match the checked registry, never a client value.
  if (!managed(row) || !row.tableName || !/^layer_[a-f0-9]{32}$/.test(row.tableName)) throw new GISProcessingError("NOT_MANAGED");
  return sql`${sql.identifier("gis")}.${sql.identifier(row.tableName)}`;
}
function safeScalar(value: unknown): value is Scalar {
  return typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))
    || (typeof value === "string" && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value));
}
async function fieldsFor(tx: AuthTransaction, row: Layer) {
  const result = await tx.execute<{ fields: string[]; sampled: boolean }>(sql`
    WITH candidates AS MATERIALIZED (
      SELECT properties FROM ${sourceTable(row)} ORDER BY feature_id LIMIT ${attributeLimits.features + 1}
    ), sample AS MATERIALIZED (SELECT properties FROM candidates LIMIT ${attributeLimits.features}),
    fields AS (
      SELECT DISTINCT attribute.key FROM sample
      CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(properties) = 'object' THEN properties ELSE '{}'::jsonb END) AS attribute
      WHERE jsonb_typeof(attribute.value) IN ('string','number','boolean')
        AND char_length(attribute.key) BETWEEN 1 AND 100
        AND attribute.key = btrim(attribute.key) AND attribute.key !~ '[[:cntrl:]]'
      ORDER BY attribute.key LIMIT ${attributeLimits.fields + 1}
    ) SELECT ARRAY(SELECT key FROM fields) AS fields,
      ((SELECT count(*) FROM candidates) > ${attributeLimits.features}) AS sampled
  `);
  const resultRow = result.rows[0];
  const rawFields = resultRow?.fields ?? [];
  const fields = rawFields.filter(isDisplayField);
  return { fields: fields.slice(0, attributeLimits.fields), sampled: Boolean(resultRow?.sampled) || rawFields.length > attributeLimits.fields };
}
async function valuesFor(tx: AuthTransaction, row: Layer, field: string) {
  if (!isDisplayField(field)) throw new GISProcessingError("INVALID_FIELD");
  const available = await fieldsFor(tx, row);
  if (!available.fields.includes(field)) throw new GISProcessingError("INVALID_FIELD");
  const result = await tx.execute<{ values: unknown[]; sampled: boolean }>(sql`
    WITH candidates AS MATERIALIZED (
      SELECT properties FROM ${sourceTable(row)} ORDER BY feature_id LIMIT ${attributeLimits.features + 1}
    ), sample AS MATERIALIZED (SELECT properties -> ${field} AS value FROM candidates LIMIT ${attributeLimits.features}),
    categories AS (
      SELECT DISTINCT value FROM sample
      WHERE jsonb_typeof(value) IN ('string','number','boolean')
        AND (jsonb_typeof(value) <> 'string' OR (char_length(value #>> '{}') <= 200 AND (value #>> '{}') !~ '[[:cntrl:]]'))
      ORDER BY value LIMIT ${attributeLimits.categories + 1}
    ) SELECT coalesce((SELECT jsonb_agg(value ORDER BY value) FROM categories), '[]'::jsonb) AS values,
      ((SELECT count(*) FROM candidates) > ${attributeLimits.features}) AS sampled
  `);
  const resultRow = result.rows[0];
  const values = (resultRow?.values ?? []).filter(safeScalar);
  return { values: values.slice(0, attributeLimits.categories), truncated: values.length > attributeLimits.categories,
    sampled: available.sampled || Boolean(resultRow?.sampled) };
}

export async function getLayerStyle(db: Database, actorId: string, layerId: string) {
  return transaction(db, actorId, async (tx) => {
    await registeredLayer(tx, layerId);
    return layerDto(tx, layerId);
  });
}
export async function getLayerAttributes(db: Database, actorId: string, layerId: string, field?: string) {
  return transaction(db, actorId, async (tx) => {
    const row = await registeredLayer(tx, layerId);
    return field === undefined ? fieldsFor(tx, row) : valuesFor(tx, row, field);
  });
}
export async function saveLayerStyle(db: Database, actorId: string, layerId: string, input: unknown) {
  return transaction(db, actorId, async (tx) => {
    const row = await registeredLayer(tx, layerId);
    let style: VectorStyle;
    try {
      const parsed = styleEnvelope.parse(input);
      if (!supportedGeometry(row.geometryType)) throw new Error("geometry");
      style = validateStyleForGeometry(parsed.style, row.geometryType);
    } catch { throw new GISProcessingError("INVALID_STYLE"); }
    if (style.label.field !== null) {
      const available = await fieldsFor(tx, row);
      if (!available.fields.includes(style.label.field)) throw new GISProcessingError("INVALID_FIELD");
    }
    if (style.category) {
      const available = await valuesFor(tx, row, style.category.field);
      if (style.category.categories.some(({ value }) => !available.values.some((actual) => typeof actual === typeof value && actual === value))) {
        throw new GISProcessingError("INVALID_CATEGORIES");
      }
    }
    await tx.update(layers).set({ styleJson: style, updatedAt: new Date() }).where(eq(layers.id, layerId));
    await tx.insert(auditLogs).values({ userId: actorId, action: "LAYER_UPDATED", targetType: "layer", targetId: layerId,
      metadata: { operation: "style", before: row.styleJson, after: style } });
    return layerDto(tx, layerId);
  });
}
export async function updateLayerSettings(db: Database, actorId: string, layerId: string, input: unknown) {
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) throw new GISProcessingError("INVALID_SETTINGS");
  await transaction(db, actorId, async (tx) => {
    const row = await registeredLayer(tx, layerId, false);
    await tx.update(layers).set({ ...parsed.data, updatedAt: new Date() }).where(eq(layers.id, layerId));
    await tx.insert(auditLogs).values({ userId: actorId, action: "LAYER_UPDATED", targetType: "layer", targetId: layerId,
      metadata: { operation: "settings", before: { groupName: row.groupName, defaultVisible: row.defaultVisible }, after: parsed.data } });
  });
  return (await listAdminLayers(db)).find((row) => row.id === layerId) ?? null;
}
export async function moveLayer(db: Database, actorId: string, input: unknown) {
  const parsed = orderSchema.safeParse(input);
  if (!parsed.success) throw new GISProcessingError("INVALID_ORDER");
  await transaction(db, actorId, async (tx) => {
    await registeredLayer(tx, parsed.data.layerId);
    const rows = await tx.select().from(layers)
      .orderBy(asc(layers.sortOrder), asc(layers.createdAt), asc(layers.id)).for("update");
    const index = rows.findIndex((row) => row.id === parsed.data.layerId);
    const direction = parsed.data.direction === "up" ? -1 : 1;
    let next = index + direction;
    while (next >= 0 && next < rows.length && !(managed(rows[next]) && rows[next].state === "READY" && supportedGeometry(rows[next].geometryType))) next += direction;
    if (index < 0) throw new GISProcessingError("NOT_FOUND");
    if (next < 0 || next >= rows.length) return;
    [rows[index], rows[next]] = [rows[next], rows[index]];
    // Normalize ties and the append sentinel atomically, preserving the exact catalog order.
    const positions = sql.join(rows.map((row, position) => sql`(${row.id}::uuid, ${position}::integer)`), sql`, `);
    await tx.execute(sql`UPDATE ${layers} AS target SET sort_order = desired.position, updated_at = now()
      FROM (VALUES ${positions}) AS desired(id, position)
      WHERE target.id = desired.id AND target.sort_order IS DISTINCT FROM desired.position`);
    await tx.insert(auditLogs).values({ userId: actorId, action: "LAYER_UPDATED", targetType: "layer", targetId: parsed.data.layerId,
      metadata: { operation: "order", direction: parsed.data.direction, before: index, after: next } });
  });
  return listAdminLayers(db);
}
export async function renameLayerGroup(db: Database, actorId: string, input: unknown) {
  const parsed = renameSchema.safeParse(input);
  if (!parsed.success) throw new GISProcessingError("INVALID_SETTINGS");
  await transaction(db, actorId, async (tx) => {
    const rows = await tx.select().from(layers).where(eq(layers.groupName, parsed.data.from)).for("update");
    if (!rows.length) throw new GISProcessingError("NOT_FOUND");
    if (rows.some((row) => !managed(row))) throw new GISProcessingError("NOT_MANAGED");
    if (rows.some((row) => row.state === "DELETING")) throw new GISProcessingError("LAYER_BUSY");
    if (parsed.data.from === parsed.data.to) return;
    await tx.update(layers).set({ groupName: parsed.data.to, updatedAt: new Date() }).where(eq(layers.groupName, parsed.data.from));
    await tx.insert(auditLogs).values(rows.map((row) => ({ userId: actorId, action: "LAYER_UPDATED" as const, targetType: "layer", targetId: row.id,
      metadata: { operation: "group", before: parsed.data.from, after: parsed.data.to } })));
  });
  return listAdminLayers(db);
}
