import { adminRequest, adminFailure, privateHeaders } from "@/server/layers/http";
import { adminJob } from "@/server/layers/management";
import { getDb } from "@/server/db";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await adminRequest(); if (actor instanceof Response) return actor;
    return Response.json(await adminJob(getDb(), (await params).id), { headers: privateHeaders });
  } catch (error) { return adminFailure(error); }
}
