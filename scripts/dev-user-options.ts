export const statuses = ["PENDING", "APPROVED", "REJECTED"] as const;
export const roles = ["VIEWER", "ADMIN"] as const;

export function parseDevUserOptions(args: string[]) {
  const allowed = new Set(["email", "status", "role", "approved-by"]);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.replace(/^--/, "");
    const value = args[index + 1];
    if (!args[index]?.startsWith("--") || !allowed.has(key) || !value || value.startsWith("--") || values.has(key)) {
      throw new Error("Use --email, --status, --approved-by, and optional --role, each once.");
    }
    values.set(key, value);
  }
  const email = values.get("email")?.trim().toLowerCase();
  const actorEmail = values.get("approved-by")?.trim().toLowerCase();
  const status = values.get("status");
  const role = values.get("role") ?? "VIEWER";
  if (!email || !actorEmail || !status || !statuses.includes(status as typeof statuses[number]) || !roles.includes(role as typeof roles[number])) {
    throw new Error("Required: --email EMAIL --status PENDING|APPROVED|REJECTED --approved-by ADMIN_EMAIL [--role VIEWER|ADMIN].");
  }
  if (status !== "APPROVED" && role !== "VIEWER") {
    throw new Error("The development command only assigns ADMIN to APPROVED users.");
  }
  return { email, actorEmail, status: status as typeof statuses[number], role: role as typeof roles[number] };
}
