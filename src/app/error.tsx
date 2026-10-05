"use client";

import Link from "next/link";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main id="main-content" className="error-layout">
      <section className="status-card">
        <span className="eyebrow">Company GIS Portal</span>
        <h1>We couldn&apos;t open the portal.</h1>
        <p className="muted">Please try again. If this continues, contact your company administrator.</p>
        <div className="error-actions"><button className="button button-primary" onClick={() => reset()}>Try again</button><Link className="button button-quiet" href="/login">Back to sign in</Link></div>
      </section>
    </main>
  );
}
