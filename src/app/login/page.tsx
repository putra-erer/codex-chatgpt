import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { signInWithGoogle } from "@/app/auth-actions";
import { PortalMark } from "@/components/portal-shell";
import { getCurrentUser } from "@/server/authorization/guards";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const user = await getCurrentUser();
  if (user?.status === "PENDING") redirect("/pending");
  if (user?.status === "REJECTED") redirect("/access-denied");
  if (user?.status === "APPROVED") redirect("/map");
  const { error } = await searchParams;

  return (
    <div className="login-layout">
      <section className="login-introduction" aria-label="About Company GIS">
        <PortalMark />
        <div className="introduction-copy">
          <span className="eyebrow light-eyebrow">A shared view. A stronger team.</span>
          <h1>Your company.<br />Connected in one place.</h1>
          <p>A dedicated workspace for your team&apos;s geographic information. Access begins with your company account.</p>
          <div className="introduction-detail">
            <span className="detail-line" />
            <span>Company GIS Portal</span>
            <span className="detail-dot" />
            <span>Internal access</span>
          </div>
        </div>
        <div className="abstract-grid" aria-hidden="true"><span /><span /><span /></div>
        <span className="introduction-footer">Built for your organization.</span>
      </section>

      <main id="main-content" className="login-main">
        <span className="access-label"><span />Authorized access</span>
        <div className="login-card">
          <span className="eyebrow">Welcome to your workspace</span>
          <h2>Sign in to Company GIS</h2>
          <p className="muted">Use your Google account to access the company portal.</p>
          {error && (
            <div className="notice notice-error" role="alert">
              Sign-in could not be completed. Please try again or contact your administrator.
            </div>
          )}
          <form action={signInWithGoogle} className="login-form">
            <button type="submit" className="button button-google">
              <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20">
                <path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-1.99 3.02v2.51h3.23c1.89-1.74 2.98-4.3 2.98-7.36Z" />
                <path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.23-2.51c-.9.6-2.04.97-3.39.97-2.6 0-4.8-1.76-5.59-4.12H3.07v2.59A10 10 0 0 0 12 22Z" />
                <path fill="#FBBC05" d="M6.41 13.93A6 6 0 0 1 6.1 12c0-.67.11-1.32.31-1.93V7.48H3.07A10 10 0 0 0 2 12c0 1.62.39 3.15 1.07 4.52l3.34-2.59Z" />
                <path fill="#EA4335" d="M12 5.95c1.47 0 2.79.51 3.82 1.51l2.87-2.87A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.93 5.48l3.34 2.59A5.99 5.99 0 0 1 12 5.95Z" />
              </svg>
              Continue with Google
            </button>
          </form>
          <div className="approval-note">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></svg>
            <div><strong>Access is managed by your administrator</strong><p>New accounts require approval before entering the workspace.</p></div>
          </div>
        </div>
        <span className="login-footer">Secure sign-in with your Google identity</span>
      </main>
    </div>
  );
}
