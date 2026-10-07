export type Bounds = [number, number, number, number];
export type LayerStyle = {
  color: string;
  opacity: number;
  width: number;
  radius: number;
};
export type MapLayer = {
  id: string;
  name: string;
  description: string;
  geometryType: "Point" | "LineString" | "Polygon";
  featureCount: number;
  bounds: Bounds;
  style: LayerStyle;
  demo: boolean;
  isVisible: boolean;
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
