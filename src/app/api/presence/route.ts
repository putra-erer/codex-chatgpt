import { cookies } from "next/headers";
import { z } from "zod";
import { getCurrentUser } from "@/server/authorization/guards";
import { getConfig } from "@/server/config";
import { getDb } from "@/server/db";
import { isPresenceOriginAllowed } from "@/server/presence/origin";
import { heartbeat, leave } from "@/server/presence/service";

const payloadSchema = z.object({ tabId: z.uuid(), activity: z.enum(["heartbeat", "leave"]) }).strict();
const noStore = { "Cache-Control": "private, no-store", Vary: "Cookie" };

function error(status: number, message: string) {
  return Response.json({ error: message }, { status, headers: noStore });
}

async function readBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 1024) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function POST(request: Request) {
  try {
    const config = getConfig();
    if (!isPresenceOriginAllowed(request.headers.get("origin"), config.AUTH_URL)) return error(403, "Invalid origin.");
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
      return error(415, "JSON required.");
    }
    const user = await getCurrentUser();
    if (!user) return error(401, "Sign in required.");
    if (user.status !== "APPROVED") return error(403, "Approved account required.");
    const body = await readBody(request);
    if (body === null) return error(400, "Invalid presence request.");
    let value: unknown;
    try { value = JSON.parse(body); } catch { return error(400, "Invalid presence request."); }
    const parsed = payloadSchema.safeParse(value);
    if (!parsed.success) return error(400, "Invalid presence request.");

    // Auth.js database sessions use an opaque, unchunked cookie. Keep the token server-only.
    const cookieName = new URL(config.AUTH_URL).protocol === "https:"
      ? "__Secure-authjs.session-token" : "authjs.session-token";
    const token = (await cookies()).get(cookieName)?.value;
    if (!token) return error(401, "Sign in required.");
    const operation = parsed.data.activity === "heartbeat" ? heartbeat : leave;
    const accepted = await operation(getDb(), user.id, token, parsed.data.tabId);
    if (!accepted) return error(403, "Session is no longer active.");
    return new Response(null, { status: 204, headers: noStore });
  } catch {
    return error(503, "Presence is temporarily unavailable.");
  }
}
