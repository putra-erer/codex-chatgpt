import { getCurrentUser } from "@/server/authorization/guards";
import { canAccessAdmin } from "@/server/authorization/policy";
import { getDb } from "@/server/db";
import { listApprovedUsers } from "@/server/users/approved";

const noStore = { "Cache-Control": "private, no-store", Vary: "Cookie" };

export async function GET(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: "Sign in required." }, { status: 401, headers: noStore });
    if (!canAccessAdmin(user)) return Response.json({ error: "Administrator access required." }, { status: 403, headers: noStore });
    const page = Number(new URL(request.url).searchParams.get("page") ?? 1);
    const data = await listApprovedUsers(getDb(), page);
    return Response.json(data, { headers: noStore });
  } catch {
    return Response.json({ error: "Account status is temporarily unavailable." }, { status: 503, headers: noStore });
  }
}
