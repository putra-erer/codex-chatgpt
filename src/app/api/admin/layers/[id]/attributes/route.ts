import { getDb } from "@/server/db";
import { adminFailure, adminRequest, privateHeaders } from "@/server/layers/http";
import { getLayerAttributes } from "@/server/layers/styling";

type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  try {
    const actor = await adminRequest(); if (actor instanceof Response) return actor;
    const field = new URL(request.url).searchParams.get("field") ?? undefined;
    const attributes = await getLayerAttributes(getDb(), actor.user.id, (await context.params).id, field);
    return Response.json(attributes, { headers: privateHeaders });
  } catch (error) { return adminFailure(error); }
}
