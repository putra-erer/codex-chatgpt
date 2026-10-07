import type { Metadata } from "next";
import Link from "next/link";
import { AdminNav } from "@/components/admin/admin-nav";
import { UserActions } from "@/components/admin/user-actions";
import { PortalShell } from "@/components/portal-shell";
import { requireAdmin } from "@/server/authorization/guards";
import { getDb } from "@/server/db";
import { listManagedUsers } from "@/server/users/management";
import {
  managementNotices,
  userFilters,
  usersUrl,
} from "@/lib/users/management";

export const metadata: Metadata = { title: "User management" };
const date = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Jakarta",
});
function timestamp(value: Date | null) {
  return value ? (
    <time dateTime={value.toISOString()}>{date.format(value)} WIB</time>
  ) : (
    <span className="muted">—</span>
  );
}
export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireAdmin();
  const query = await searchParams;
  const filters = userFilters(query);
  const result = await listManagedUsers(getDb(), filters);
  filters.page = result.page;
  const notice =
    typeof query.result === "string" &&
    Object.hasOwn(managementNotices, query.result)
      ? managementNotices[query.result]
      : undefined;
  return (
    <PortalShell user={actor} current="admin">
      <AdminNav current="users" />
      <div className="page-heading">
        <div>
          <span className="eyebrow">Administration</span>
          <h1>User management</h1>
          <p className="muted">
            Review registrations, manage access, and assign roles.
          </p>
        </div>
        <span className="status-badge badge-neutral">
          {result.total} accounts
        </span>
      </div>
      {notice && (
        <div
          className={`notice approval-notice ${notice.error ? "notice-error" : "notice-success"}`}
          role={notice.error ? "alert" : "status"}
        >
          {notice.message}
        </div>
      )}
      <section className="approval-panel" aria-label="Users">
        <form className="user-filters" action="/admin/users" method="get">
          <label>
            Search
            <input
              name="q"
              type="search"
              defaultValue={filters.q}
              placeholder="Name or email"
              maxLength={100}
            />
          </label>
          <label>
            Status
            <select name="status" defaultValue={filters.status}>
              <option value="ALL">All statuses</option>
              <option value="PENDING">Pending</option>
              <option value="APPROVED">Approved</option>
              <option value="REJECTED">Rejected</option>
            </select>
          </label>
          <label>
            Role
            <select name="role" defaultValue={filters.role}>
              <option value="ALL">All roles</option>
              <option value="VIEWER">Viewer</option>
              <option value="ADMIN">Admin</option>
            </select>
          </label>
          <button className="button button-primary" type="submit">
            Apply filters
          </button>
          <Link className="button button-quiet" href="/admin/users">
            Reset
          </Link>
        </form>
        {result.users.length ? (
          <div
            className="users-table-scroll"
            tabIndex={0}
            role="region"
            aria-label="User account details, scroll horizontally for actions"
          >
            <table className="users-table">
              <caption className="approval-sr-only">
                Registered users and their access permissions
              </caption>
              <thead>
                <tr>
                  {[
                    "Name",
                    "Email",
                    "Status",
                    "Role",
                    "Registration date",
                    "Approved by",
                    "Approved at",
                    "Actions",
                  ].map((title) => (
                    <th key={title} scope="col">
                      {title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.users.map((account) => (
                  <tr key={account.id}>
                    <td>
                      <strong>{account.name || "Unnamed account"}</strong>
                      {account.id === actor.id && (
                        <small className="muted">You</small>
                      )}
                    </td>
                    <td>{account.email}</td>
                    <td>
                      <span
                        className={`status-badge badge-${account.status.toLowerCase()}`}
                      >
                        {account.status}
                      </span>
                    </td>
                    <td>{account.role}</td>
                    <td>{timestamp(account.createdAt)}</td>
                    <td>
                      {account.approverEmail ? (
                        <>
                          <strong>
                            {account.approverName || "Administrator"}
                          </strong>
                          <small>({account.approverEmail})</small>
                        </>
                      ) : (
                        <span className="muted">
                          {account.status === "APPROVED"
                            ? "System / unavailable"
                            : "—"}
                        </span>
                      )}
                    </td>
                    <td>{timestamp(account.approvedAt)}</td>
                    <td>
                      <UserActions
                        key={account.version}
                        account={account}
                        filters={filters}
                        self={account.id === actor.id}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="approval-empty">
            <h2>No users match these filters</h2>
            <p className="muted">
              Try a different name, email, status, or role.
            </p>
            <Link href="/admin/users" className="button button-quiet">
              Show all users
            </Link>
          </div>
        )}
        <div className="approval-list-footer">
          <p className="muted">
            {result.users.length} of {result.total} accounts · Dates in WIB
          </p>
          <nav className="approval-pagination" aria-label="User list pages">
            {result.page > 1 && (
              <Link
                className="button button-quiet"
                href={usersUrl({ ...filters, page: result.page - 1 })}
              >
                Previous
              </Link>
            )}
            <span>
              Page {result.page} of {result.totalPages}
            </span>
            {result.page < result.totalPages && (
              <Link
                className="button button-quiet"
                href={usersUrl({ ...filters, page: result.page + 1 })}
              >
                Next
              </Link>
            )}
          </nav>
        </div>
      </section>
      <p className="muted admin-help">
        New accounts start as Viewers. Approval preserves an explicitly assigned
        role. Protected administrators and the last approved administrator
        cannot lose access here.
      </p>
    </PortalShell>
  );
}
