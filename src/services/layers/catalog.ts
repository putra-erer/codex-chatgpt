import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/server/db";
import { layers, type AppUser } from "@/server/db/schema";
import type { Bounds, MapLayer } from "@/lib/gis/types";
import { normalizeVectorStyle } from "@/lib/gis/style";

type Actor = Pick<AppUser, "status" | "role">;
export const vectorTileLimits = { candidates: 10_000, bytes: 2 * 1024 * 1024, timeoutMs: 5_000 } as const;
export class VectorTileLimitError extends Error {
  constructor(public readonly code: "TILE_TOO_DENSE" | "TILE_TOO_LARGE" | "TILE_TIMEOUT") { super(code); }
}
function timedOut(error: unknown): boolean {
  for (let depth = 0; error && typeof error === "object" && depth < 5; depth++) {
    if ("code" in error && error.code === "57014") return true;
    error = "cause" in error ? error.cause : undefined;
  }
  return false;
}
function access(actor: Actor) {
  if (actor.status !== "APPROVED") throw new Error("APPROVED_REQUIRED");
  return and(
    eq(layers.state, "READY"),
    eq(layers.layerType, "VECTOR"),
    actor.role === "ADMIN" ? undefined : eq(layers.isVisible, true),
  );
}
export const mapLayerFields = {
  id: layers.id,
  name: layers.name,
  description: layers.description,
  geometryType: layers.geometryType,
  featureCount: layers.featureCount,
  style: layers.styleJson,
  isVisible: layers.isVisible,
  defaultVisible: layers.defaultVisible,
  groupName: layers.groupName,
  sortOrder: layers.sortOrder,
  updatedAt: layers.updatedAt,
  bounds: sql<Bounds>`json_build_array(ST_XMin(${layers.bbox}::box3d), ST_YMin(${layers.bbox}::box3d), ST_XMax(${layers.bbox}::box3d), ST_YMax(${layers.bbox}::box3d))`,
};
export function mapLayerDto(row: Record<string, unknown>): MapLayer {
  const geometryType = z.enum(["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"]).parse(row.geometryType);
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string,
    geometryType,
    featureCount: Number(row.featureCount ?? 0),
    bounds: row.bounds as Bounds,
    style: normalizeVectorStyle(row.style, geometryType),
    isVisible: Boolean(row.isVisible),
    defaultVisible: Boolean(row.defaultVisible),
    groupName: typeof row.groupName === "string" ? row.groupName : null,
    sortOrder: Number(row.sortOrder),
    updatedAt: (row.updatedAt as Date).toISOString(),
  };
}
export async function listLayers(actor: Actor) {
  const rows = await getDb()
    .select(mapLayerFields)
    .from(layers)
    .where(access(actor))
    .orderBy(asc(layers.sortOrder), asc(layers.createdAt), asc(layers.id));
  return rows.map(mapLayerDto);
}
export async function getLayer(actor: Actor, id: string) {
  if (!z.uuid().safeParse(id).success) return null;
  const [row] = await getDb()
    .select(mapLayerFields)
    .from(layers)
    .where(and(access(actor), eq(layers.id, id)))
    .limit(1);
  return row ? mapLayerDto(row) : null;
}
export async function getVectorTile(
  actor: Actor,
  id: string,
  zLevel: number,
  x: number,
  y: number,
) {
  if (!z.uuid().safeParse(id).success) return null;
  try {
    return await getDb().transaction(async (tx) => {
      // The timeout is transaction-local; it cannot leak to the next pooled request.
      await tx.execute(sql`SELECT set_config('statement_timeout', ${String(vectorTileLimits.timeoutMs)}, true)`);
      const [layer] = await tx.select({ tableName: layers.tableName }).from(layers)
        .where(and(access(actor), eq(layers.id, id))).limit(1);
      if (!layer?.tableName || !/^layer_[0-9a-f]{32}$/.test(layer.tableName)) return null;
      // Identifier comes exclusively from the checked registry; coordinates remain parameters.
      const table = sql`${sql.identifier("gis")}.${sql.identifier(layer.tableName)}`;
      const result = await tx.execute<{ tile: Buffer | null; feature_count: number; tile_bytes: number }>(sql`
        WITH bounds AS (SELECT ST_TileEnvelope(${zLevel}, ${x}, ${y}) AS geom),
        candidates AS MATERIALIZED (
          SELECT source.* FROM ${table} AS source CROSS JOIN bounds
          WHERE source.geom && ST_Transform(ST_Expand(bounds.geom, (ST_XMax(bounds.geom)-ST_XMin(bounds.geom))*64/4096),4326)
          LIMIT ${vectorTileLimits.candidates + 1}
        ), total AS (SELECT count(*)::integer AS feature_count FROM candidates),
        features AS (
          SELECT feature_id, properties, ST_AsMVTGeom(ST_Transform(source.geom,3857),bounds.geom,4096,64,true) AS geom
          FROM candidates AS source CROSS JOIN bounds CROSS JOIN total
          WHERE total.feature_count <= ${vectorTileLimits.candidates}
          ORDER BY feature_id
        ), encoded AS MATERIALIZED (
          SELECT ST_AsMVT(features,'features',4096,'geom','feature_id') AS tile FROM features WHERE geom IS NOT NULL
        ) SELECT total.feature_count, octet_length(encoded.tile) AS tile_bytes,
          CASE WHEN octet_length(encoded.tile) <= ${vectorTileLimits.bytes} THEN encoded.tile ELSE NULL END AS tile
          FROM encoded CROSS JOIN total
      `);
      const row = result.rows[0];
      if (row.feature_count > vectorTileLimits.candidates) throw new VectorTileLimitError("TILE_TOO_DENSE");
      if (row.tile_bytes > vectorTileLimits.bytes || row.tile === null) throw new VectorTileLimitError("TILE_TOO_LARGE");
      return row.tile;
    });
  } catch (error) {
    if (timedOut(error)) throw new VectorTileLimitError("TILE_TIMEOUT");
    throw error;
  }
}
