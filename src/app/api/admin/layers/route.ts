import { adminRequest, adminFailure, privateHeaders } from "@/server/layers/http";
import { listAdminLayers } from "@/server/layers/management";
import { getDb } from "@/server/db";
export async function GET() {
  try {
    const actor = await adminRequest(); if (actor instanceof Response) return actor;
    return Response.json({ layers: await listAdminLayers(getDb()), csrfToken: actor.csrfToken }, { headers: privateHeaders });
  } catch (error) { return adminFailure(error); }
}
