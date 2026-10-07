"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { APPROVED_REFRESH_INTERVAL_MS, type ApprovedUser, type ApprovedUsersPage } from "@/shared/presence";

const approvalDate = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "Asia/Jakarta",
});

function AccountName({ name, email }: { name: string | null; email: string }) {
  return <><strong>{name || "Unnamed account"}</strong> <span className="approved-account-email">({email})</span></>;
}

function ApprovedBy({ account }: { account: ApprovedUser }) {
  if (account.approvalSource === "bootstrap") return <>System <span className="approved-account-email">(SUPER_ADMIN_EMAILS)</span></>;
  if (account.approvalSource === "administrator" && account.approvedBy) return <AccountName {...account.approvedBy} />;
  return <span className="muted">Approval record unavailable</span>;
}

export function ApprovedUsersPanel({ initialData }: { initialData: ApprovedUsersPage }) {
  const [data, setData] = useState(initialData);
  const [refreshing, setRefreshing] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const currentPage = useRef(initialData.page);
  const requestId = useRef(0);
  const request = useRef<AbortController | null>(null);

  const cancelRefresh = useCallback(() => {
    request.current?.abort();
    ++requestId.current;
  }, []);

  const refresh = useCallback(async (page: number) => {
    if (document.visibilityState !== "visible") return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const id = ++requestId.current;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 8_000);
    setRefreshing(true);
    try {
      const response = await fetch(`/api/admin/users/approved?page=${page}`, {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (id !== requestId.current) return;
      if (response.status === 401 || response.status === 403) {
        setForbidden(true);
        window.location.assign(response.status === 401 ? "/login" : "/access-denied");
        return;
      }
      if (!response.ok) throw new Error("Approved accounts could not be refreshed.");
      const nextData = await response.json() as ApprovedUsersPage;
      if (id !== requestId.current || controller.signal.aborted) return;
      currentPage.current = nextData.page;
      setData(nextData);
      setError(null);
      setUnavailable(false);
    } catch {
      if (id === requestId.current && (!controller.signal.aborted || timedOut)) {
        setUnavailable(true);
        setError("Updates are unavailable. The list below may be out of date; online status will return when the connection is restored.");
      }
    } finally {
      clearTimeout(timeout);
      if (id === requestId.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const update = () => { void refresh(currentPage.current); };
    const visibilityChanged = () => {
      if (document.visibilityState === "visible") update();
      else cancelRefresh();
    };
    const offline = () => {
      cancelRefresh();
      setRefreshing(false);
      setUnavailable(true);
      setError("You are offline. Online status is unavailable until your connection returns.");
    };
    update();
    const interval = setInterval(update, APPROVED_REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", visibilityChanged);
    window.addEventListener("online", update);
    window.addEventListener("offline", offline);
    return () => {
      cancelRefresh();
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visibilityChanged);
      window.removeEventListener("online", update);
      window.removeEventListener("offline", offline);
    };
  }, [initialData, refresh, cancelRefresh]);

  if (forbidden) return null;

  return (
    <section className="approval-panel approved-users-panel" aria-labelledby="approved-users-heading">
      <div className="approval-panel-heading">
        <div>
          <div className="approval-title">
            <h2 id="approved-users-heading">Approved accounts</h2>
            <span className="status-badge badge-approved">{data.total} approved</span>
          </div>
          <p className="muted">See who has access to your workspace and who approved each account.</p>
        </div>
        <button type="button" className="button button-quiet approved-refresh" onClick={() => void refresh(data.page)} disabled={refreshing}>
          {refreshing ? "Refreshing…" : "Refresh list"}
        </button>
      </div>
      <div className="approved-presence-note">
        <span className="approved-live-label"><span className={`presence-dot ${unavailable ? "presence-offline" : "presence-online"}`} aria-hidden="true" />{unavailable ? "Updates unavailable" : "Automatic updates"}</span>
        <p>Updates every 10 seconds. Online means the portal is open in a visible tab. Disconnected accounts appear offline within about a minute.</p>
      </div>
      {error && <div className="notice notice-error approved-update-error" role="alert">{error}</div>}
      {data.users.length ? (
        <>
          <table className="approved-users-table">
            <caption className="approval-sr-only">Approved accounts, online status, approval date, and approving administrator</caption>
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Status</th>
                <th scope="col">Approved on (WIB)</th>
                <th scope="col">Approved by</th>
              </tr>
            </thead>
            <tbody>
              {data.users.map((account) => (
                <tr key={account.id} data-approved-user-id={account.id}>
                  <td className="approved-user-account"><AccountName name={account.name} email={account.email} /></td>
                  <td className="approved-user-status">
                    <span className="approval-mobile-label">Status</span>
                    <span className={`presence-status ${!unavailable && account.online ? "is-online" : "is-offline"}`}>
                      <span className={`presence-dot ${!unavailable && account.online ? "presence-online" : "presence-offline"}`} aria-hidden="true" />
                      {unavailable ? "Unknown" : account.online ? "Online" : "Offline"}
                    </span>
                  </td>
                  <td className="approved-user-date">
                    <span className="approval-mobile-label">Approved on (WIB)</span>
                    {account.approvedAt ? <time dateTime={account.approvedAt}>{approvalDate.format(new Date(account.approvedAt))} WIB</time> : <span className="muted">Date unavailable</span>}
                  </td>
                  <td className="approved-user-approver">
                    <span className="approval-mobile-label">Approved by</span>
                    <ApprovedBy account={account} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="approval-list-footer">
            <p className="muted">{data.users.length} of {data.total} approved {data.total === 1 ? "account" : "accounts"}</p>
            {data.totalPages > 1 && (
              <nav className="approval-pagination" aria-label="Approved account pages">
                <button type="button" className="button button-quiet" onClick={() => void refresh(data.page - 1)} disabled={refreshing || data.page <= 1}>Previous</button>
                <span>Page {data.page} of {data.totalPages}</span>
                <button type="button" className="button button-quiet" onClick={() => void refresh(data.page + 1)} disabled={refreshing || data.page >= data.totalPages}>Next</button>
              </nav>
            )}
          </div>
        </>
      ) : (
        <div className="approval-empty approved-empty">
          <h3>No approved accounts</h3>
          <p className="muted">Accounts will appear here after an administrator approves access.</p>
        </div>
      )}
    </section>
  );
}
