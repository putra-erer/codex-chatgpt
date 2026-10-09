import { getDb } from "@/server/db";
import { adminFailure, adminRequest, privateHeaders, readMetadata } from "@/server/layers/http";
import { renameLayerGroup } from "@/server/layers/styling";

export async function PATCH(request: Request) {
  try {
    const actor = await adminRequest(request); if (actor instanceof Response) return actor;
    const layers = await renameLayerGroup(getDb(), actor.user.id, await readMetadata(request));
    return Response.json({ layers }, { headers: privateHeaders });
  } catch (error) { return adminFailure(error); }
}
