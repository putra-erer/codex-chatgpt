import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/server/db";
import { layers, type AppUser } from "@/server/db/schema";
import type { Bounds, MapLayer } from "@/lib/gis/types";

const styleSchema = z.object({
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  opacity: z.number().min(0).max(1),
  width: z.number().min(0.5).max(12),
  radius: z.number().min(2).max(20),
});
type Actor = Pick<AppUser, "status" | "role">;
function access(actor: Actor) {
  if (actor.status !== "APPROVED") throw new Error("APPROVED_REQUIRED");
  return and(
    eq(layers.state, "READY"),
    eq(layers.layerType, "VECTOR"),
    actor.role === "ADMIN" ? undefined : eq(layers.isVisible, true),
  );
}
const fields = {
  id: layers.id,
  name: layers.name,
  description: layers.description,
  geometryType: layers.geometryType,
  featureCount: layers.featureCount,
  style: layers.styleJson,
  isVisible: layers.isVisible,
  bounds: sql<Bounds>`json_build_array(ST_XMin(${layers.bbox}::box3d), ST_YMin(${layers.bbox}::box3d), ST_XMax(${layers.bbox}::box3d), ST_YMax(${layers.bbox}::box3d))`,
};
function dto(row: Record<string, unknown>): MapLayer {
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string,
    geometryType: z
      .enum(["Point", "LineString", "Polygon"])
      .parse(row.geometryType),
    featureCount: Number(row.featureCount ?? 0),
    bounds: row.bounds as Bounds,
    style: styleSchema.parse(row.style),
    isVisible: Boolean(row.isVisible),
  };
}
export async function listLayers(actor: Actor) {
  const rows = await getDb()
    .select(fields)
    .from(layers)
    .where(access(actor))
    .orderBy(asc(layers.createdAt), asc(layers.id));
  return rows.map(dto);
}
export async function getLayer(actor: Actor, id: string) {
  if (!z.uuid().safeParse(id).success) return null;
  const [row] = await getDb()
    .select(fields)
    .from(layers)
    .where(and(access(actor), eq(layers.id, id)))
    .limit(1);
  return row ? dto(row) : null;
}
export async function getVectorTile(
  actor: Actor,
  id: string,
  zLevel: number,
  x: number,
  y: number,
) {
  if (!z.uuid().safeParse(id).success) return null;
  const [layer] = await getDb()
    .select({ tableName: layers.tableName })
    .from(layers)
    .where(and(access(actor), eq(layers.id, id)))
    .limit(1);
  if (!layer?.tableName || !/^layer_[0-9a-f]{32}$/.test(layer.tableName))
    return null;
  // Identifier comes exclusively from the checked server registry. All coordinates are parameters.
  const table = sql`${sql.identifier("gis")}.${sql.identifier(layer.tableName)}`;
  const result = await getDb().execute<{ tile: Buffer }>(sql`
    WITH bounds AS (SELECT ST_TileEnvelope(${zLevel}, ${x}, ${y}) AS geom),
    features AS (
      SELECT feature_id, properties, ST_AsMVTGeom(ST_Transform(source.geom,3857),bounds.geom,4096,64,true) AS geom
      FROM ${table} AS source CROSS JOIN bounds
      WHERE source.geom && ST_Transform(ST_Expand(bounds.geom, (ST_XMax(bounds.geom)-ST_XMin(bounds.geom))*64/4096),4326)
    ) SELECT ST_AsMVT(features,'features',4096,'geom','feature_id') AS tile FROM features WHERE geom IS NOT NULL
  `);
  return result.rows[0].tile;
}
