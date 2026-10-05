import type { Metadata } from "next";
import { PortalShell, StatusIcon } from "@/components/portal-shell";
import { requireAdmin } from "@/server/authorization/guards";

export const metadata: Metadata = { title: "Administration" };

export default async function AdminPage() {
  const user = await requireAdmin();

  return (
    <PortalShell user={user} current="admin">
      <div className="page-heading"><div><span className="eyebrow">Company portal</span><h1>Administration</h1><p className="muted">Your administrator access is active.</p></div><span className="status-badge badge-approved"><span className="badge-dot" />Administrator</span></div>
      <section className="workspace-placeholder admin-placeholder">
        <div className="placeholder-content"><StatusIcon variant="admin" /><span className="eyebrow">Administration workspace</span><h2>The right access. A shared foundation.</h2><p className="muted">This area is reserved for approved administrators. Administration tools will be available in a future release.</p><span className="release-label">Workspace preview</span></div>
      </section>
      <div className="workspace-summary"><div><span>Administrator account</span><strong>{user.email}</strong></div><div><span>Access level</span><strong>Administrator</strong></div><div><span>Account status</span><strong className="text-teal">Approved</strong></div></div>
    </PortalShell>
  );
}
