import { adminRequest, adminFailure, privateHeaders, readMetadata } from "@/server/layers/http";
import { editLayer, enqueueDelete } from "@/server/layers/management";
import { getDb } from "@/server/db";
type Context = { params: Promise<{ id: string }> };
export async function PATCH(request: Request, context: Context) {
  try {
    const actor = await adminRequest(request); if (actor instanceof Response) return actor;
    const layer = await editLayer(getDb(), actor.user.id, (await context.params).id, await readMetadata(request));
    return Response.json({ layer }, { headers: privateHeaders });
  } catch (error) { return adminFailure(error); }
}
export async function DELETE(request: Request, context: Context) {
  try {
    const actor = await adminRequest(request); if (actor instanceof Response) return actor;
    const job = await enqueueDelete(getDb(), actor.user.id, (await context.params).id);
    return Response.json(job, { status: 202, headers: privateHeaders });
  } catch (error) { return adminFailure(error); }
}
