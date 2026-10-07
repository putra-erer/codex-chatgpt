import { listLayers } from "@/services/layers/catalog";
import {
  gisUser,
  gisUnavailable,
  privateHeaders,
} from "@/services/layers/http";
export async function GET() {
  try {
    const user = await gisUser();
    if (user instanceof Response) return user;
    return Response.json(
      { layers: await listLayers(user) },
      { headers: privateHeaders },
    );
  } catch {
    return gisUnavailable();
  }
}
