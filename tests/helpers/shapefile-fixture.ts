import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export type ShapeFixtureOptions = {
  geometry?: "point" | "multipoint" | "line" | "multiline" | "polygon" | "multipolygon" | "null" | "invalid";
  targetCrs?: string;
  omit?: string[];
  invalidCrs?: boolean;
};

/** Runtime-only fixtures in an isolated temporary directory; never application seeds. */
export async function createShapefileFixture(
  directory: string,
  options: ShapeFixtureOptions = {},
): Promise<string> {
  const folder = join(directory, `shape-${randomUUID()}`);
  await mkdir(folder, { recursive: true });
  const kind = options.geometry ?? "polygon";
  const geometries = {
    point: { type: "Point", coordinates: [106.82, -6.2] },
    multipoint: { type: "MultiPoint", coordinates: [[106.82, -6.2], [106.825, -6.195]] },
    multiline: {
      type: "MultiLineString",
      coordinates: [[[106.815, -6.205], [106.82, -6.2]], [[106.825, -6.195], [106.83, -6.19]]],
    },
    multipolygon: {
      type: "MultiPolygon",
      coordinates: [
        [[[106.81, -6.21], [106.815, -6.21], [106.815, -6.205], [106.81, -6.205], [106.81, -6.21]]],
        [[[106.825, -6.195], [106.83, -6.195], [106.83, -6.19], [106.825, -6.19], [106.825, -6.195]]],
      ],
    },
    line: {
      type: "LineString",
      coordinates: [[106.815, -6.205], [106.825, -6.195]],
    },
    polygon: {
      type: "Polygon",
      coordinates: [[[106.81, -6.21], [106.83, -6.21], [106.83, -6.19], [106.81, -6.19], [106.81, -6.21]]],
    },
    null: null,
    invalid: {
      type: "Polygon",
      coordinates: [[[106.81, -6.21], [106.83, -6.19], [106.81, -6.19], [106.83, -6.21], [106.81, -6.21]]],
    },
  };
  const input = join(folder, "input.geojson");
  await writeFile(input, JSON.stringify({
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: geometries[kind],
      properties: { name: "Kebun café 中文", category: "Runtime fixture", hectares: 42.25 },
    }],
  }));
  const output = join(folder, "fixture.shp");
  const args = ["-f", "ESRI Shapefile", output, input, "-lco", "ENCODING=UTF-8", "-s_srs", "EPSG:4326", "-t_srs", options.targetCrs ?? "EPSG:4326"];
  if (kind === "null") args.push("-nlt", "POINT");
  await execute("ogr2ogr", args, { timeout: 20_000, maxBuffer: 1024 * 1024 });
  if (options.invalidCrs) await writeFile(join(folder, "fixture.prj"), "NOT_A_VALID_COORDINATE_REFERENCE_SYSTEM");
  const files = (await readdir(folder))
    .filter((name) => name.startsWith("fixture.") && !options.omit?.includes(name.split(".").at(-1)!))
    .map((name) => join(folder, name));
  const archive = join(folder, "fixture.zip");
  await execute("zip", ["-q", "-j", archive, ...files], { timeout: 10_000 });
  return archive;
}
