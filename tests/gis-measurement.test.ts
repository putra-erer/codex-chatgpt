import { describe, expect, it } from "vitest";
import {
  formatArea,
  formatLength,
  lineMeters,
  polygonSquareMeters,
} from "@/lib/gis/measurement";
import type { Coordinate } from "@/lib/gis/types";
describe("geodesic measurement and display", () => {
  it("needs two points for distance and three for area", () => {
    expect(lineMeters([])).toBe(0);
    expect(lineMeters([[0, 0]])).toBe(0);
    expect(
      polygonSquareMeters([
        [0, 0],
        [1, 0],
      ]),
    ).toBe(0);
  });
  it("calculates an equatorial degree with great-circle distance", () => {
    expect(
      lineMeters([
        [0, 0],
        [1, 0],
      ]),
    ).toBeCloseTo(111195.08, 1);
  });
  it("accumulates segments and changes when a point is adjusted", () => {
    const points: Coordinate[] = [
      [0, 0],
      [1, 0],
      [2, 0],
    ];
    expect(lineMeters(points)).toBeCloseTo(
      lineMeters([
        [0, 0],
        [1, 0],
      ]) * 2,
      4,
    );
    expect(
      lineMeters([
        [0, 0],
        [1, 1],
        [2, 0],
      ]),
    ).toBeGreaterThan(lineMeters(points));
  });
  it("computes a closed geographic area regardless of winding direction", () => {
    const points: Coordinate[] = [
      [0, 0],
      [0.001, 0],
      [0.001, 0.001],
      [0, 0.001],
    ];
    expect(polygonSquareMeters(points)).toBeCloseTo(12364.3459, 1);
    expect(polygonSquareMeters([...points].reverse())).toBeCloseTo(
      polygonSquareMeters(points),
      4,
    );
  });
  it("converts meter/kilometer and square meter/hectare/kilometer with exactly two decimals", () => {
    expect(formatLength(1234.567, "m")).toBe("1234.57 m");
    expect(formatLength(1234.567, "km")).toBe("1.23 km");
    expect(formatArea(1234567.89, "m²")).toBe("1234567.89 m²");
    expect(formatArea(1234567.89, "ha")).toBe("123.46 ha");
    expect(formatArea(1234567.89, "km²")).toBe("1.23 km²");
    expect(formatArea(0, "ha")).toBe("0.00 ha");
  });
});
