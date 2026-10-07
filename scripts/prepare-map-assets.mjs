import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve("maplibre-gl/package.json"));
const destination = new URL("../public/vendor/maplibre/", import.meta.url);
await mkdir(destination, { recursive: true });
await copyFile(
  join(packageRoot, "dist/maplibre-gl-worker.mjs"),
  new URL("worker.mjs", destination),
);
await copyFile(
  join(packageRoot, "LICENSE.txt"),
  new URL("LICENSE.txt", destination),
);
console.info("Prepared local MapLibre worker and license.");
