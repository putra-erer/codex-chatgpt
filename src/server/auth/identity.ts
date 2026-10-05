import { z } from "zod";

const verifiedGoogleProfile = z.object({
  sub: z.string().min(1),
  email: z.string().trim().email().transform((email) => email.toLowerCase()),
  email_verified: z.literal(true),
  name: z.string().nullish(),
  picture: z.string().url().nullish(),
});

export function parseGoogleIdentity(profile: unknown) {
  const parsed = verifiedGoogleProfile.safeParse(profile);
  if (!parsed.success) throw new Error("Google requires a verified email and valid account identity");
  return {
    googleId: parsed.data.sub,
    email: parsed.data.email,
    name: parsed.data.name ?? null,
    image: parsed.data.picture ?? null,
  };
}

export type GoogleIdentity = ReturnType<typeof parseGoogleIdentity>;

export function isSuperAdminEmail(email: string, configuredEmails: string) {
  const entries = configuredEmails.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  return entries.includes(email.trim().toLowerCase());
}

export function assertGoogleAccount(account: { provider: string; providerAccountId: string; type: string }, identity?: GoogleIdentity) {
  if (account.provider !== "google" || !["oidc", "oauth"].includes(account.type)
    || !account.providerAccountId || (identity && account.providerAccountId !== identity.googleId)) {
    throw new Error("Invalid Google account identity");
  }
}

export function assertIdentityMatches(
  identity: GoogleIdentity,
  user: { googleId: string | null; email: string },
) {
  if (user.googleId && user.googleId !== identity.googleId) throw new Error("Google identity conflict");
}
