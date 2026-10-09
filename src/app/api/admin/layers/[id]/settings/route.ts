import { getDb } from "@/server/db";
import { adminFailure, adminRequest, privateHeaders, readMetadata } from "@/server/layers/http";
import { updateLayerSettings } from "@/server/layers/styling";

type Context = { params: Promise<{ id: string }> };
export async function PATCH(request: Request, context: Context) {
  try {
    const actor = await adminRequest(request); if (actor instanceof Response) return actor;
    const layer = await updateLayerSettings(getDb(), actor.user.id, (await context.params).id, await readMetadata(request));
    return Response.json({ layer }, { headers: privateHeaders });
  } catch (error) { return adminFailure(error); }
}
