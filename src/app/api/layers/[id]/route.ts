import { getLayer } from "@/services/layers/catalog";
import {
  gisUser,
  gisError,
  gisUnavailable,
  privateHeaders,
} from "@/services/layers/http";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await gisUser();
    if (user instanceof Response) return user;
    const layer = await getLayer(user, (await params).id);
    return layer
      ? Response.json(layer, { headers: privateHeaders })
      : gisError(404, "LAYER_NOT_FOUND", "Layer not available.");
  } catch {
    return gisUnavailable();
  }
}
