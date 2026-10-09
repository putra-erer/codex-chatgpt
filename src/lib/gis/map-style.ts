import type {
  AllLayoutProperties,
  AllPaintProperties,
  ExpressionSpecification,
  LayerSpecification,
  Map as LibreMap,
} from "maplibre-gl";
import { categoryColorExpression, normalizeVectorStyle } from "@/lib/gis/style";
import type { MapLayer } from "@/lib/gis/types";

export const vectorSourceId = (id: string) => `gis-${id}`;
export const vectorLayerIds = (id: string) => {
  const base = vectorSourceId(id);
  return [base, `${base}-outline`, `${base}-label`];
};

/** Only our validated style properties become MapLibre expressions. */
export function vectorLayerSpecifications(layer: MapLayer, visible: boolean): LayerSpecification[] {
  const style = normalizeVectorStyle(layer.style, layer.geometryType);
  const id = vectorSourceId(layer.id);
  const base = {
    id,
    source: id,
    "source-layer": "features",
    minzoom: style.minZoom,
    maxzoom: style.maxZoom,
  };
  const visibility = visible ? "visible" : "none";
  const color = categoryColorExpression(style);
  const layers: LayerSpecification[] = [];
  if (style.type === "point") {
    layers.push({
      ...base,
      type: "circle",
      layout: { visibility },
      paint: {
        "circle-color": color,
        "circle-radius": style.radius,
        "circle-opacity": style.opacity,
        "circle-stroke-color": style.strokeColor,
        "circle-stroke-width": style.strokeWidth,
        "circle-stroke-opacity": style.strokeOpacity,
      },
    });
  } else if (style.type === "line") {
    layers.push({
      ...base,
      type: "line",
      layout: { visibility, "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": color,
        "line-width": style.width,
        "line-opacity": style.opacity,
        ...(style.dash === "solid" ? {} : {
          "line-dasharray": style.dash === "dashed" ? [3, 2] : [0.1, 2],
        }),
      },
    });
  } else {
    layers.push({
      ...base,
      type: "fill",
      layout: { visibility },
      paint: { "fill-color": color, "fill-opacity": style.opacity },
    }, {
      ...base,
      id: `${id}-outline`,
      type: "line",
      layout: { visibility, "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": style.strokeColor,
        "line-width": style.strokeWidth,
        "line-opacity": style.strokeOpacity,
      },
    });
  }

  const field = style.label.field;
  // Scalar attribute text only, capped before glyph shaping. No HTML or user expressions.
  const text: string | ExpressionSpecification = field === null ? "" : [
    "case",
    ["in", ["typeof", ["get", field]], ["literal", ["string", "number", "boolean"]]],
    ["slice", ["to-string", ["get", field]], 0, 120],
    "",
  ];
  const labelMinZoom = Math.max(style.minZoom, style.label.minZoom);
  const labelMaxZoom = Math.min(style.maxZoom, style.label.maxZoom);
  layers.push({
    ...base,
    id: `${id}-label`,
    type: "symbol",
    minzoom: labelMinZoom,
    maxzoom: Math.max(labelMinZoom, labelMaxZoom),
    layout: {
      visibility: visible && style.label.enabled && field !== null && labelMinZoom < labelMaxZoom ? "visible" : "none",
      "symbol-placement": style.type === "line" ? "line" : "point",
      "symbol-spacing": 250,
      "text-field": text,
      // MapLibre 6.13 rasterizes all glyphs locally when the style has no glyphs URL.
      "text-font": ["sans-serif"],
      "text-size": style.label.size,
      "text-max-width": 12,
      "text-padding": 3,
      "text-allow-overlap": false,
      "text-ignore-placement": false,
      "text-anchor": style.type === "point" ? "top" : "center",
      "text-offset": style.type === "point" ? [0, 1.2] : [0, 0],
    },
    paint: {
      "text-color": style.label.color,
      "text-halo-color": style.label.haloColor,
      "text-halo-width": style.label.haloWidth,
    },
  });
  return layers;
}

type VectorMap = Pick<LibreMap,
  "getStyle" | "getSource" | "addSource" | "removeSource" | "getLayer" | "addLayer" |
  "removeLayer" | "setPaintProperty" | "setLayoutProperty" | "setLayerZoomRange" | "moveLayer"
>;

const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Update the existing renderer without replacing the map or its vector tile sources. */
export function synchronizeVectorLayers(
  map: VectorMap,
  layers: MapLayer[],
  visible: Record<string, boolean>,
  origin: string,
  before = "measure-fill",
) {
  const sourceIds = new Set(layers.map((layer) => vectorSourceId(layer.id)));
  const desired = [...layers].reverse().flatMap((layer) =>
    vectorLayerSpecifications(layer, visible[layer.id] ?? layer.defaultVisible),
  );
  const desiredIds = new Set(desired.map((layer) => layer.id));
  const currentStyle = map.getStyle();
  const currentLayers = new Map(currentStyle.layers.map((layer) => [layer.id, layer]));
  // Every sublayer must be removed before removing the corresponding source.
  for (const layer of currentStyle.layers) {
    if (layer.id.startsWith("gis-") && !desiredIds.has(layer.id)) map.removeLayer(layer.id);
  }
  for (const id of Object.keys(currentStyle.sources)) {
    if (id.startsWith("gis-") && !sourceIds.has(id)) map.removeSource(id);
  }
  for (const layer of layers) {
    const id = vectorSourceId(layer.id);
    if (!map.getSource(id)) {
      map.addSource(id, {
        type: "vector",
        tiles: [`${origin}/api/layers/${layer.id}/tiles/{z}/{x}/{y}.pbf`],
        minzoom: 0,
        maxzoom: 18,
      });
    }
  }
  for (const specification of desired) {
    const current = currentLayers.get(specification.id);
    if (!current || current.type !== specification.type) {
      if (current) map.removeLayer(specification.id);
      map.addLayer(specification, before);
      continue;
    }
    for (const name of new Set([...Object.keys(current.paint ?? {}), ...Object.keys(specification.paint ?? {})])) {
      const property = name as keyof AllPaintProperties;
      const oldValue = (current.paint as AllPaintProperties | undefined)?.[property];
      const nextValue = (specification.paint as AllPaintProperties | undefined)?.[property];
      if (!equal(oldValue, nextValue)) map.setPaintProperty(specification.id, property, nextValue);
    }
    for (const name of new Set([...Object.keys(current.layout ?? {}), ...Object.keys(specification.layout ?? {})])) {
      const property = name as keyof AllLayoutProperties;
      const oldValue = (current.layout as AllLayoutProperties | undefined)?.[property];
      const nextValue = (specification.layout as AllLayoutProperties | undefined)?.[property];
      if (!equal(oldValue, nextValue)) map.setLayoutProperty(specification.id, property, nextValue);
    }
    if (current.minzoom !== specification.minzoom || current.maxzoom !== specification.maxzoom) {
      map.setLayerZoomRange(specification.id, specification.minzoom ?? 0, specification.maxzoom ?? 24);
    }
  }
  const actualOrder = map.getStyle().layers.filter((layer) => desiredIds.has(layer.id)).map((layer) => layer.id);
  if (!equal(actualOrder, desired.map((layer) => layer.id))) {
    // Catalog index zero is topmost. Base, outline, and label remain contiguous.
    for (const layer of desired) map.moveLayer(layer.id, before);
  }
}
