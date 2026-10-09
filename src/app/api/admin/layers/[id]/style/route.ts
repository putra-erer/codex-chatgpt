import { getDb } from "@/server/db";
import { adminFailure, adminRequest, privateHeaders, readMetadata } from "@/server/layers/http";
import { getLayerStyle, saveLayerStyle } from "@/server/layers/styling";

type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  try {
    const actor = await adminRequest(); if (actor instanceof Response) return actor;
    const layer = await getLayerStyle(getDb(), actor.user.id, (await context.params).id);
    return Response.json({ layer, csrfToken: actor.csrfToken }, { headers: privateHeaders });
  } catch (error) { return adminFailure(error); }
}
export async function PUT(request: Request, context: Context) {
  try {
    const actor = await adminRequest(request); if (actor instanceof Response) return actor;
    const layer = await saveLayerStyle(getDb(), actor.user.id, (await context.params).id, await readMetadata(request, 65536));
    return Response.json({ layer }, { headers: privateHeaders });
  } catch (error) { return adminFailure(error); }
}
