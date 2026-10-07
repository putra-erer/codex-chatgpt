import { getVectorTile } from "@/services/layers/catalog";
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
  } catch {
    return gisUnavailable();
  }
}
