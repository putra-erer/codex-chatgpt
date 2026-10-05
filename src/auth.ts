import "server-only";
import NextAuth, { type NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import { createPortalAdapter } from "@/server/auth/adapter";
import { parseGoogleIdentity, type GoogleIdentity } from "@/server/auth/identity";
import { synchronizeGoogleLogin } from "@/server/auth/service";
import { getConfig } from "@/server/config";
import { getDb } from "@/server/db";
import { auditLogs } from "@/server/db/schema";

export function createAuthConfig(): NextAuthConfig {
  const config = getConfig();
  const db = getDb();
  // A new config/closure is created per request. Verified identity never crosses requests.
  let verifiedIdentity: GoogleIdentity | undefined;
  return {
    secret: config.AUTH_SECRET,
    // AUTH_URL is mandatory and fixes the external origin; requests must reach a trusted proxy.
    trustHost: true,
    adapter: createPortalAdapter(db, config.SUPER_ADMIN_EMAILS, () => verifiedIdentity),
    session: { strategy: "database", maxAge: 8 * 60 * 60, updateAge: 60 * 60 },
    pages: { signIn: "/login", error: "/login" },
    providers: [Google({
      clientId: config.GOOGLE_CLIENT_ID,
      clientSecret: config.GOOGLE_CLIENT_SECRET,
      allowDangerousEmailAccountLinking: false,
      authorization: { params: { scope: "openid email profile", prompt: "select_account" } },
      profile(profile) {
        const identity = parseGoogleIdentity(profile);
        return {
          id: identity.googleId,
          email: identity.email,
          name: identity.name,
          image: identity.image,
          emailVerified: new Date(),
        };
      },
    })],
    callbacks: {
      async signIn({ account, profile }) {
        verifiedIdentity = undefined;
        if (!account || account.provider !== "google") return false;
        try {
          const identity = parseGoogleIdentity(profile);
          await synchronizeGoogleLogin(db, identity, account, config.SUPER_ADMIN_EMAILS);
          verifiedIdentity = identity;
          return true;
        } catch {
          // Do not expose profile, credential, or database errors in a browser response.
          return false;
        }
      },
      async session({ session, user }) {
        session.user.id = user.id;
        // The adapter joins the live user on every session read. Guards also re-read it.
        session.user.role = user.role;
        session.user.status = user.status;
        return session;
      },
      redirect() {
        // Route through /login so the server reads the current approval status.
        // Arbitrary callbackUrl values cannot jump directly into protected content.
        return new URL("/login", config.AUTH_URL).toString();
      },
    },
    events: {
      async signIn({ user }) {
        await db.insert(auditLogs).values({ userId: user.id, action: "LOGIN", targetId: user.id });
      },
    },
  };
}

export const { handlers, auth, signIn, signOut } = NextAuth(createAuthConfig);
