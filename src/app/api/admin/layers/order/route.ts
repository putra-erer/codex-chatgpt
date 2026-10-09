import { getDb } from "@/server/db";
import { adminFailure, adminRequest, privateHeaders, readMetadata } from "@/server/layers/http";
import { moveLayer } from "@/server/layers/styling";

export async function POST(request: Request) {
  try {
    const actor = await adminRequest(request); if (actor instanceof Response) return actor;
    const layers = await moveLayer(getDb(), actor.user.id, await readMetadata(request));
    return Response.json({ layers }, { headers: privateHeaders });
  } catch (error) { return adminFailure(error); }
}
