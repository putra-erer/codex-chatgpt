import { z } from "zod";

const configSchema = z.object({
  DATABASE_URL: z.string().url().refine((value) => /^postgres(?:ql)?:/.test(value)),
  AUTH_URL: z.string().url().refine((value) => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.pathname === "/"
      && !url.search && !url.hash && !url.username && !url.password;
  }, "AUTH_URL must be an HTTP(S) origin without a path, query, or credentials"),
  AUTH_SECRET: z.string().min(32),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  SUPER_ADMIN_EMAILS: z.string().default(""),
});

export function parseConfig(env: Record<string, string | undefined>) {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    // Report names only. A connection URL and OAuth secrets must never enter logs.
    const keys = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`Missing or invalid environment configuration: ${keys.join(", ")}`);
  }
  return parsed.data;
}

export function getConfig() {
  return parseConfig(process.env);
}
