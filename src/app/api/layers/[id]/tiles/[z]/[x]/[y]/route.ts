import { getVectorTile, VectorTileLimitError } from "@/services/layers/catalog";
import {
  gisUser,
  gisError,
  gisUnavailable,
  privateHeaders,
} from "@/services/layers/http";
export async function GET(
  _request: Request,
  {
    params,
  }: { params: Promise<{ id: string; z: string; x: string; y: string }> },
) {
  try {
    const user = await gisUser();
    if (user instanceof Response) return user;
    const p = await params;
    const values = [p.z, p.x, p.y.replace(/\.pbf$/, "")];
    if (!values.every((value) => /^\d{1,8}$/.test(value)))
      return gisError(400, "INVALID_TILE", "Invalid tile coordinates.");
    const [z, x, y] = values.map(Number);
    if (z > 22 || x >= 2 ** z || y >= 2 ** z)
      return gisError(400, "INVALID_TILE", "Invalid tile coordinates.");
    const tile = await getVectorTile(user, p.id, z, x, y);
    if (tile === null)
      return gisError(404, "LAYER_NOT_FOUND", "Layer not available.");
    return new Response(new Uint8Array(tile), {
      headers: {
        ...privateHeaders,
        "Content-Type": "application/vnd.mapbox-vector-tile",
      },
    });
  } catch (error) {
    if (error instanceof VectorTileLimitError) {
      return gisError(error.code === "TILE_TIMEOUT" ? 503 : 422, error.code,
        "This tile exceeds the map delivery limit. Zoom in or ask an administrator to split the dataset.");
    }
    return gisUnavailable();
  }
}
