import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { getCurrentUser } from "@/server/authorization/guards";
import { getConfig } from "@/server/config";
import { isPresenceOriginAllowed } from "@/server/presence/origin";
import { gisError, privateHeaders } from "@/services/layers/http";
import { GISProcessingError, publicGisError } from "@/server/processing/errors";

export { privateHeaders };
export async function adminRequest(request?: Request) {
  const user = await getCurrentUser();
  if (!user) return gisError(401, "UNAUTHENTICATED", "Sign in required.");
  if (user.status !== "APPROVED" || user.role !== "ADMIN") return gisError(403, "FORBIDDEN", "Approved administrator required.");
  const config = getConfig();
  const cookieName = new URL(config.AUTH_URL).protocol === "https:" ? "__Secure-authjs.session-token" : "authjs.session-token";
  const sessionToken = (await cookies()).get(cookieName)?.value;
  if (!sessionToken) return gisError(401, "UNAUTHENTICATED", "Sign in required.");
  const csrfToken = createHmac("sha256", config.AUTH_SECRET).update(`gis-admin\0${user.id}\0${sessionToken}`).digest("hex");
  if (request) {
    const supplied = request.headers.get("x-gis-csrf") ?? "";
    if (!isPresenceOriginAllowed(request.headers.get("origin"), config.AUTH_URL) || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(csrfToken))) {
      return gisError(403, "INVALID_CSRF", "Refresh the page and submit from the portal.");
    }
  }
  return { user, csrfToken };
}
export function adminFailure(error: unknown) {
  if (!(error instanceof GISProcessingError)) return gisError(503, "GIS_UNAVAILABLE", "GIS management is temporarily unavailable. Please try again.");
  const safe = publicGisError(error.code);
  const status = error.code === "FORBIDDEN" ? 403 : error.code === "NOT_FOUND" ? 404
    : error.code === "UPLOAD_TOO_LARGE" ? 413 : error.code === "QUEUE_FULL" ? 429
    : ["DUPLICATE_NAME", "LAYER_BUSY", "NOT_MANAGED"].includes(error.code) ? 409
    : ["STORAGE_ERROR", "GDAL_UNAVAILABLE", "DATABASE_UNAVAILABLE", "ATTRIBUTE_QUERY_TIMEOUT"].includes(error.code) ? 503 : 422;
  return gisError(status, safe.code, safe.message);
}
export async function readMetadata(request: Request, maxBytes = 16384) {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new GISProcessingError("INVALID_METADATA");
  const reader = request.body?.getReader();
  if (!reader) throw new GISProcessingError("INVALID_METADATA");
  const chunks: Uint8Array[] = []; let size = 0;
  const timeout = setTimeout(() => void reader.cancel().catch(() => {}), 15000);
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new GISProcessingError("INVALID_METADATA"); }
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
    catch { throw new GISProcessingError("INVALID_METADATA"); }
  } finally { clearTimeout(timeout); reader.releaseLock(); }
}
