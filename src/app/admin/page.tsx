import type { Metadata } from "next";
import Link from "next/link";
import { approveUser } from "@/app/admin/actions";
import { ApproveUserButton } from "@/components/approve-user-button";
import { PortalShell, StatusIcon } from "@/components/portal-shell";
import { requireAdmin } from "@/server/authorization/guards";
import { getDb } from "@/server/db";
import { listPendingUsers } from "@/server/users/approval";

export const metadata: Metadata = { title: "Administration" };

const notices: Record<string, { message: string; error?: boolean }> = {
  approved: { message: "Account approved. This person can now access the map workspace as a Viewer." },
  "already-approved": { message: "This account has already been approved. The list is up to date." },
  "not-pending": { message: "This account is no longer waiting for approval. The list is up to date." },
  invalid: { message: "We could not identify that account. Refresh the list and try again.", error: true },
  error: { message: "The account could not be approved. Please try again.", error: true },
};

const requestedDate = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string | string[]; result?: string | string[] }>;
}) {
  const user = await requireAdmin();
  const query = await searchParams;
  const requestedPage = typeof query.page === "string" ? Number(query.page) : 1;
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const pending = await listPendingUsers(getDb(), page);
  const notice = typeof query.result === "string" && Object.hasOwn(notices, query.result)
    ? notices[query.result]
    : undefined;

  return (
    <PortalShell user={user} current="admin">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Company portal</span>
          <h1>Administration</h1>
          <p className="muted">Your administrator access is active.</p>
        </div>
        <span className="status-badge badge-approved"><span className="badge-dot" />Administrator</span>
      </div>

      {notice && (
        <div className={`notice approval-notice ${notice.error ? "notice-error" : "notice-success"}`} role={notice.error ? "alert" : "status"}>
          {notice.message}
        </div>
      )}

      <section className="approval-panel" aria-labelledby="approvals-heading">
        <div className="approval-panel-heading">
          <div>
            <div className="approval-title">
              <h2 id="approvals-heading">Account approvals</h2>
              <span className="status-badge badge-pending">{pending.total} pending</span>
            </div>
            <p className="muted">Review new registrations and approve access to your company workspace.</p>
          </div>
          <form action="/admin" method="get">
            <input type="hidden" name="page" value={pending.page} />
            <button type="submit" className="button button-quiet">Refresh list</button>
          </form>
        </div>

        {pending.users.length ? (
          <>
            <p className="approval-access-note">Approving an account grants Viewer access to the map workspace.</p>
            <table className="approval-table">
              <caption className="approval-sr-only">Accounts waiting for administrator approval</caption>
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col">Requested</th>
                  <th scope="col">Access after approval</th>
                  <th scope="col"><span className="approval-sr-only">Action</span></th>
                </tr>
              </thead>
              <tbody>
                {pending.users.map((account) => (
                  <tr key={account.id}>
                    <td className="approval-account">
                      <strong>{account.name || "New account"}</strong>
                      <span>{account.email}</span>
                    </td>
                    <td className="approval-date">
                      <span className="approval-mobile-label">Requested</span>
                      <time dateTime={account.createdAt.toISOString()}>{requestedDate.format(account.createdAt)}</time>
                    </td>
                    <td className="approval-role">
                      <span className="approval-mobile-label">Access after approval</span>
                      <span className="status-badge badge-neutral">Viewer</span>
                    </td>
                    <td className="approval-action">
                      <form action={approveUser} data-user-id={account.id}>
                        <input type="hidden" name="userId" value={account.id} />
                        <input type="hidden" name="page" value={pending.page} />
                        <ApproveUserButton email={account.email} />
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="approval-list-footer">
              <p className="muted">{pending.users.length} of {pending.total} pending {pending.total === 1 ? "account" : "accounts"}</p>
              {pending.totalPages > 1 && (
                <nav className="approval-pagination" aria-label="Account approval pages">
                  {pending.page > 1 && <Link className="button button-quiet" href={`/admin?page=${pending.page - 1}`} prefetch={false}>Previous</Link>}
                  <span>Page {pending.page} of {pending.totalPages}</span>
                  {pending.page < pending.totalPages && <Link className="button button-quiet" href={`/admin?page=${pending.page + 1}`} prefetch={false}>Next</Link>}
                </nav>
              )}
            </div>
          </>
        ) : (
          <div className="approval-empty">
            <StatusIcon variant="admin" />
            <h3>No accounts waiting for approval</h3>
            <p className="muted">New registrations will appear here. Refresh the list after someone signs in for the first time.</p>
          </div>
        )}
      </section>

      <div className="workspace-summary">
        <div><span>Administrator account</span><strong>{user.email}</strong></div>
        <div><span>Access level</span><strong>Administrator</strong></div>
        <div><span>Account status</span><strong className="text-teal">Approved</strong></div>
      </div>
    </PortalShell>
  );
}
