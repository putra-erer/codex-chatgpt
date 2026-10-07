import "server-only";
import { getCurrentUser } from "@/server/authorization/guards";
export const privateHeaders = {
  "Cache-Control": "private, no-store",
  Vary: "Cookie",
};
export function gisError(status: number, code: string, message: string) {
  return Response.json({ code, message }, { status, headers: privateHeaders });
}
export async function gisUser() {
  const user = await getCurrentUser();
  if (!user) return gisError(401, "UNAUTHENTICATED", "Sign in required.");
  if (user.status !== "APPROVED")
    return gisError(403, "NOT_APPROVED", "Approved account required.");
  return user;
}
export function gisUnavailable() {
  return gisError(
    503,
    "GIS_UNAVAILABLE",
    "Map data is temporarily unavailable. Please try again.",
  );
}
