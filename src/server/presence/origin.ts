/** Match the configured public origin, with the existing development-only Codespaces exception. */
export function isPresenceOriginAllowed(origin: string | null, configuredUrl: string) {
  if (!origin) return false;
  try {
    if (origin === new URL(configuredUrl).origin) return true;
  } catch {
    return false;
  }
  return process.env.NODE_ENV === "development" && process.env.CODESPACES === "true"
    && origin === "http://localhost:3000";
}
