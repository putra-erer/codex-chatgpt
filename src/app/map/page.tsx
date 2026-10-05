import type { Metadata } from "next";
import { PortalShell, StatusIcon } from "@/components/portal-shell";
import { requireApprovedUser } from "@/server/authorization/guards";

export const metadata: Metadata = { title: "Map workspace" };

export default async function MapPage() {
  const user = await requireApprovedUser();

  return (
    <PortalShell user={user} current="map">
      <div className="page-heading"><div><span className="eyebrow">Your company workspace</span><h1>Map workspace</h1><p className="muted">Welcome{user.name ? `, ${user.name}` : ""}. Your account is approved.</p></div><span className="status-badge badge-approved"><span className="badge-dot" />Access approved</span></div>
      <section className="workspace-placeholder">
        <div className="placeholder-grid" aria-hidden="true" />
        <div className="placeholder-content"><StatusIcon variant="map" /><span className="eyebrow">The foundation is ready</span><h2>A place for your spatial workspace.</h2><p className="muted">You&apos;re connected to the company portal. Maps and geographic data will be available in a future release.</p><span className="release-label">Workspace preview</span></div>
      </section>
      <div className="workspace-summary"><div><span>Account</span><strong>{user.email}</strong></div><div><span>Access level</span><strong>{user.role === "ADMIN" ? "Administrator" : "Viewer"}</strong></div><div><span>Account status</span><strong className="text-teal">Approved</strong></div></div>
    </PortalShell>
  );
}
