import { resolve } from "node:path";

function integer(name: string, fallback: number, min: number, max: number) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid GIS configuration: ${name}`);
  return value;
}
/** Server/worker only. Defaults are deliberately bounded for development. */
export function gisLimits() {
  return {
    maxUploadBytes: integer("GIS_UPLOAD_MAX_MB", 50, 1, 250) * 1024 * 1024,
    maxExtractBytes: integer("GIS_EXTRACT_MAX_MB", 250, 1, 1024) * 1024 * 1024,
    maxEntryBytes: integer("GIS_ENTRY_MAX_MB", 200, 1, 512) * 1024 * 1024,
    maxEntries: 32,
    maxCompressionRatio: 100,
    maxFeatures: integer("GIS_MAX_FEATURES", 500_000, 1, 2_000_000),
    processTimeoutMs: integer("GIS_PROCESS_TIMEOUT_SECONDS", 300, 10, 600) * 1000,
    // Private runtime storage is mounted/provisioned separately from the server bundle.
    storageRoot: resolve(/* turbopackIgnore: true */ process.env.GIS_STORAGE_ROOT || "data/gis"),
  };
}
