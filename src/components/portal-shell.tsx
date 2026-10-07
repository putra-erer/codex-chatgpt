import Link from "next/link";
import type { ReactNode } from "react";
import { signOutOfPortal } from "@/app/auth-actions";
import { PresenceHeartbeat } from "@/components/presence-heartbeat";

type PortalUser = {
  email: string;
  name: string | null;
  status: string;
  role: string;
};

export function PortalMark({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className="brand" aria-label="Company GIS Portal home">
      <span className="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 32 32" fill="none">
          <path d="m16 4 12 7-12 7L4 11l12-7Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="m4 16 12 7 12-7M4 21l12 7 12-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className="brand-copy">
        <strong>Company GIS</strong>
        {!compact && <span>Internal company portal</span>}
      </span>
    </Link>
  );
}

export function PortalShell({
  user,
  current,
  children,
  fullWidth = false,
}: {
  user: PortalUser;
  current?: "map" | "admin";
  children: ReactNode;
  fullWidth?: boolean;
}) {
  const isApproved = user.status === "APPROVED";

  return (
    <div className={`portal-layout ${fullWidth ? "portal-map-layout" : ""}`}>
      {isApproved && <PresenceHeartbeat />}
      <header className="portal-header">
        <div className="header-content">
          <PortalMark />
          <div className="header-account">
            <div className="account-details">
              <strong>{user.name || user.email}</strong>
              <span>{user.email}</span>
            </div>
            <form action={signOutOfPortal}>
              <button className="button button-quiet" type="submit">Sign out</button>
            </form>
          </div>
        </div>
      </header>

      {isApproved && (
        <nav className="portal-navigation" aria-label="Portal navigation">
          <div className="navigation-content">
            <Link href="/map" className={current === "map" ? "nav-link active" : "nav-link"} aria-current={current === "map" ? "page" : undefined}>Map workspace</Link>
            {user.role === "ADMIN" && (
              <Link href="/admin" className={current === "admin" ? "nav-link active" : "nav-link"} aria-current={current === "admin" ? "page" : undefined}>Administration</Link>
            )}
            <span className="navigation-badge">{user.role === "ADMIN" ? "Administrator" : "Viewer"}</span>
          </div>
        </nav>
      )}

      <main id="main-content" className={fullWidth ? "portal-map-main" : "portal-main"}>{children}</main>
      {!fullWidth && <footer className="portal-footer">
        <span>Company GIS Portal</span>
        <span>For authorized company users</span>
      </footer>}
    </div>
  );
}

export function StatusIcon({ variant }: { variant: "pending" | "denied" | "map" | "admin" }) {
  return (
    <span className={`status-icon status-icon-${variant}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        {variant === "pending" && <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3 2" /></>}
        {variant === "denied" && <><path d="M12 3 4.5 6v5c0 4.5 3.1 7.8 7.5 10 4.4-2.2 7.5-5.5 7.5-10V6L12 3Z" /><path d="m9 9 6 6m0-6-6 6" /></>}
        {variant === "map" && <><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z" /><path d="M9 3v15M15 6v15" /></>}
        {variant === "admin" && <><path d="M12 3 4.5 6v5c0 4.5 3.1 7.8 7.5 10 4.4-2.2 7.5-5.5 7.5-10V6L12 3Z" /><path d="m8.5 11.5 2.5 2.5 4.5-4.5" /></>}
      </svg>
    </span>
  );
}
