import { basemaps } from "@/lib/gis/basemaps";
import {
  gisUser,
  gisUnavailable,
  privateHeaders,
} from "@/services/layers/http";
export async function GET() {
  try {
    const user = await gisUser();
    if (user instanceof Response) return user;
    return Response.json({ basemaps }, { headers: privateHeaders });
  } catch {
    return gisUnavailable();
  }
}
