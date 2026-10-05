import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { recheckAccess } from "@/app/auth-actions";
import { PortalShell, StatusIcon } from "@/components/portal-shell";
import { requireUser } from "@/server/authorization/guards";

export const metadata: Metadata = { title: "Access denied" };

export default async function AccessDeniedPage() {
  const user = await requireUser();
  if (user.status === "PENDING") redirect("/pending");
  if (user.status === "APPROVED" && user.role === "ADMIN") redirect("/admin");
  const isRejected = user.status === "REJECTED";

  return (
    <PortalShell user={user}>
      <section className="status-card">
        <StatusIcon variant="denied" />
        <span className="eyebrow">Access restricted</span>
        <h1>{isRejected ? "Your access was not approved." : "This area requires administrator access."}</h1>
        <p className="status-lead">{isRejected ? "Your account does not currently have access to the company workspace." : "Your account does not have permission to open the requested area."}</p>
        <p className="muted">Contact your company administrator if you believe your access should be updated.</p>
        <div className="identity-panel"><span>Signed in as</span><strong>{user.email}</strong><span className={`status-badge ${isRejected ? "badge-denied" : "badge-neutral"}`}>{isRejected ? "Access rejected" : user.role === "ADMIN" ? "Administrator" : "Viewer access"}</span></div>
        {isRejected ? (
          <form action={recheckAccess}><button className="button button-primary" type="submit">Check access status<span aria-hidden="true">↗</span></button></form>
        ) : (
          <Link className="button button-primary" href="/map">Back to workspace<span aria-hidden="true">↗</span></Link>
        )}
      </section>
    </PortalShell>
  );
}
