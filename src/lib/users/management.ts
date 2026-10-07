import { z } from "zod";

export const statuses = ["PENDING", "APPROVED", "REJECTED"] as const;
export const roles = ["VIEWER", "ADMIN"] as const;
export type UserFilters = {
  status: "ALL" | (typeof statuses)[number];
  role: "ALL" | (typeof roles)[number];
  q: string;
  page: number;
};
export function userFilters(query: Record<string, unknown>): UserFilters {
  const status = z
    .enum(["ALL", ...statuses])
    .catch("ALL")
    .parse(query.status);
  const role = z
    .enum(["ALL", ...roles])
    .catch("ALL")
    .parse(query.role);
  const q = typeof query.q === "string" ? query.q.trim().slice(0, 100) : "";
  const n = typeof query.page === "string" ? Number(query.page) : 1;
  return {
    status,
    role,
    q,
    page: Number.isSafeInteger(n) && n > 0 ? Math.min(n, 1_000_000) : 1,
  };
}
export function usersUrl(filters: UserFilters, result?: string) {
  const params = new URLSearchParams({
    status: filters.status,
    role: filters.role,
    q: filters.q,
    page: String(filters.page),
  });
  if (result) params.set("result", result);
  return `/admin/users?${params}`;
}
export const changeSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("approve"),
    userId: z.uuid(),
    version: z.string().min(1).max(80),
  }),
  z.object({
    action: z.literal("reject"),
    userId: z.uuid(),
    version: z.string().min(1).max(80),
  }),
  z.object({
    action: z.literal("role"),
    userId: z.uuid(),
    version: z.string().min(1).max(80),
    role: z.enum(roles),
  }),
]);
export type UserChange = z.infer<typeof changeSchema>;
export const managementNotices: Record<
  string,
  { message: string; error?: boolean }
> = {
  approved: { message: "Account approved. Access is available immediately." },
  rejected: {
    message: "Account rejected. Existing sessions have been revoked.",
  },
  role: { message: "Role updated. The new permissions apply immediately." },
  unchanged: { message: "This account already has the requested settings." },
  invalid: {
    message: "Invalid request. Refresh the list and try again.",
    error: true,
  },
  missing: {
    message: "This account no longer exists. Refresh the list.",
    error: true,
  },
  identity: {
    message:
      "This account needs a verified Google identity before it can be managed.",
    error: true,
  },
  conflict: {
    message:
      "This account changed since you opened the page. Review the refreshed details and try again.",
    error: true,
  },
  bootstrap: {
    message:
      "This account is protected by SUPER_ADMIN_EMAILS and cannot be rejected or demoted here.",
    error: true,
  },
  "last-admin": {
    message:
      "At least one approved administrator must remain. Approve another administrator first.",
    error: true,
  },
  failed: {
    message: "The change could not be saved. Please try again.",
    error: true,
  },
};
