import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { recheckAccess } from "@/app/auth-actions";
import { PortalShell, StatusIcon } from "@/components/portal-shell";
import { requireUser } from "@/server/authorization/guards";

export const metadata: Metadata = { title: "Awaiting approval" };

export default async function PendingPage() {
  const user = await requireUser();
  if (user.status === "APPROVED") redirect("/map");
  if (user.status === "REJECTED") redirect("/access-denied");

  return (
    <PortalShell user={user}>
      <section className="status-card">
        <StatusIcon variant="pending" />
        <span className="eyebrow">Account review</span>
        <h1>You&apos;re on the list.</h1>
        <p className="status-lead">Your account is waiting for administrator approval.</p>
        <p className="muted">You have successfully signed in. An administrator needs to approve your account before you can enter the workspace.</p>
        <div className="identity-panel"><span>Signed in as</span><strong>{user.email}</strong><span className="status-badge badge-pending">Pending approval</span></div>
        <form action={recheckAccess}><button className="button button-primary" type="submit">Check approval status<span aria-hidden="true">↗</span></button></form>
        <p className="card-footnote">Contact your company administrator if you need access.</p>
      </section>
    </PortalShell>
  );
}
