import type { VectorStyle } from "@/lib/gis/style";

export type Bounds = [number, number, number, number];
export type GeometryType = "Point" | "MultiPoint" | "LineString" | "MultiLineString" | "Polygon" | "MultiPolygon";
export function geometryFamily(type: GeometryType): "Point" | "LineString" | "Polygon" {
  if (type === "Point" || type === "MultiPoint") return "Point";
  if (type === "LineString" || type === "MultiLineString") return "LineString";
  return "Polygon";
}
export type LayerStyle = VectorStyle;
export type MapLayer = {
  id: string;
  name: string;
  description: string;
  geometryType: GeometryType;
  featureCount: number;
  bounds: Bounds;
  style: LayerStyle;
  isVisible: boolean;
  groupName: string | null;
  sortOrder: number;
  defaultVisible: boolean;
  updatedAt: string;
};
export type Basemap = {
  id: string;
  name: string;
  description: string;
  background: string;
  tiles?: string[];
  attribution?: string;
  maxZoom?: number;
};
export type Coordinate = [number, number];
export type MeasureMode = "none" | "line" | "polygon";
export type LengthUnit = "m" | "km";
export type AreaUnit = "m²" | "ha" | "km²";
