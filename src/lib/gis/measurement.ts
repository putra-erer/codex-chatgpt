import { area } from "@turf/area";
import { length } from "@turf/length";
import { lineString, polygon } from "@turf/helpers";
import type { AreaUnit, Coordinate, LengthUnit } from "./types";

export function lineMeters(points: Coordinate[]) {
  return points.length < 2
    ? 0
    : length(lineString(points), { units: "meters" });
}
export function polygonSquareMeters(points: Coordinate[]) {
  return points.length < 3 ? 0 : area(polygon([[...points, points[0]]]));
}
export function formatLength(meters: number, unit: LengthUnit) {
  return `${(unit === "km" ? meters / 1000 : meters).toFixed(2)} ${unit}`;
}
export function formatArea(squareMeters: number, unit: AreaUnit) {
  return `${(squareMeters / (unit === "ha" ? 10000 : unit === "km²" ? 1000000 : 1)).toFixed(2)} ${unit}`;
}
