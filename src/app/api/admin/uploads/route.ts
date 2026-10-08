import { randomUUID } from "node:crypto";
import { adminRequest, adminFailure, privateHeaders } from "@/server/layers/http";
import { getDb } from "@/server/db";
import { checkUploadCapacity, enqueueUpload } from "@/server/layers/management";
import { gisLimits } from "@/server/processing/config";
import { cleanupUpload, receiveShapefileUpload } from "@/server/storage/local";
import { withUploadSlot } from "@/server/layers/upload-slots";

export const runtime = "nodejs";
export async function GET() {
  try {
    const actor = await adminRequest(); if (actor instanceof Response) return actor;
    return Response.json({ csrfToken: actor.csrfToken, limits: { maxUploadBytes: gisLimits().maxUploadBytes } }, { headers: privateHeaders });
  } catch (error) { return adminFailure(error); }
}
export async function POST(request: Request) {
  let uploadId: string | undefined;
  try {
    const actor = await adminRequest(request); if (actor instanceof Response) return actor;
    await checkUploadCapacity(getDb(), actor.user.id);
    return await withUploadSlot(actor.user.id, async () => {
      uploadId = randomUUID();
      const upload = await receiveShapefileUpload(request, uploadId);
      const result = await enqueueUpload(getDb(), actor.user.id, uploadId, upload.fields);
      uploadId = undefined; // The durable queue owns quarantine cleanup from now on.
      return Response.json(result, { status: 202, headers: privateHeaders });
    });
  } catch (error) {
    if (uploadId) await cleanupUpload(uploadId).catch(() => {});
    return adminFailure(error);
  }
}
