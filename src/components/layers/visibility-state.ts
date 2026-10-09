const layerIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Browser preferences cannot grant access; the server still filters the catalog. */
export function parseVisibilityOverrides(raw: string | null): Record<string, boolean> {
  if (!raw || raw.length > 300_000) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed)
      .filter(([id, value]) => layerIdPattern.test(id) && typeof value === "boolean")
      .slice(0, 5000));
  } catch {
    return {};
  }
}

export function visibilityStorageKey(userId: string): string {
  return `company-gis:layer-visibility:v1:${userId}`;
}
