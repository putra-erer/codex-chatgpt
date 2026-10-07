export const HEARTBEAT_INTERVAL_MS = 20_000;
export const ONLINE_WINDOW_SECONDS = 60;
export const APPROVED_REFRESH_INTERVAL_MS = 10_000;

export type ApprovedUser = {
  id: string;
  name: string | null;
  email: string;
  approvedAt: string | null;
  approvedBy: { name: string | null; email: string } | null;
  approvalSource: "administrator" | "bootstrap" | "unavailable";
  online: boolean;
};

export type ApprovedUsersPage = {
  users: ApprovedUser[];
  total: number;
  page: number;
  totalPages: number;
};
