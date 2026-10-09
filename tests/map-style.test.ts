import { describe, expect, it, vi } from "vitest";
import { createExpression, latest, validateStyleMin, type StylePropertySpecification } from "@maplibre/maplibre-gl-style-spec";
import type { LayerSpecification, SourceSpecification, StyleSpecification } from "maplibre-gl";
import { synchronizeVectorLayers, vectorLayerSpecifications } from "@/lib/gis/map-style";
import { defaultVectorStyle } from "@/lib/gis/style";
import type { GeometryType, MapLayer } from "@/lib/gis/types";

function layer(id: string, geometryType: GeometryType = "Polygon"): MapLayer {
  return {
    id, geometryType, name: id, description: "", bounds: [106, -7, 107, -6],
    featureCount: 1, style: defaultVectorStyle(geometryType), isVisible: true,
    defaultVisible: true, groupName: null, sortOrder: 0, updatedAt: new Date(0).toISOString(),
  };
}

function mapDouble() {
  const state: StyleSpecification = {
    version: 8,
    sources: { measurement: { type: "geojson", data: { type: "FeatureCollection", features: [] } } },
    layers: [{ id: "measure-fill", type: "fill", source: "measurement" }],
  };
  const find = (id: string) => state.layers.find((item) => item.id === id);
  const map = {
    getStyle: () => structuredClone(state),
    getSource: (id: string) => state.sources[id],
    addSource: vi.fn((id: string, source: SourceSpecification) => { state.sources[id] = structuredClone(source); }),
    removeSource: vi.fn((id: string) => {
      if (state.layers.some((item) => "source" in item && item.source === id)) throw new Error("Source is still in use");
      delete state.sources[id];
    }),
    getLayer: find,
    addLayer: vi.fn((specification: LayerSpecification, before: string) => {
      state.layers.splice(state.layers.findIndex((item) => item.id === before), 0, structuredClone(specification));
    }),
    removeLayer: vi.fn((id: string) => { state.layers = state.layers.filter((item) => item.id !== id); }),
    setPaintProperty: vi.fn((id: string, name: string, value: unknown) => {
      const item = find(id)!;
      const paint = item.paint as Record<string, unknown> ?? {};
      if (value === undefined) delete paint[name];
      else paint[name] = value;
      item.paint = paint;
    }),
    setLayoutProperty: vi.fn((id: string, name: string, value: unknown) => {
      const item = find(id)!;
      const layout = item.layout as Record<string, unknown> ?? {};
      if (value === undefined) delete layout[name];
      else layout[name] = value;
      item.layout = layout;
    }),
    setLayerZoomRange: vi.fn((id: string, minzoom: number, maxzoom: number) => {
      Object.assign(find(id)!, { minzoom, maxzoom });
    }),
    moveLayer: vi.fn((id: string, before: string) => {
      const item = find(id)!;
      state.layers = state.layers.filter((entry) => entry.id !== id);
      state.layers.splice(state.layers.findIndex((entry) => entry.id === before), 0, item);
    }),
  };
  return { map, state, render: (layers: MapLayer[], visibility: Record<string, boolean> = {}) =>
    synchronizeVectorLayers(map as unknown as Parameters<typeof synchronizeVectorLayers>[0], layers, visibility, "https://portal.test") };
}

describe("vector styling integration with MapLibre", () => {
  it.each<GeometryType>(["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"])(
    "produces a valid style with local labels and mixed scalar categories for %s", (geometry) => {
      const item = layer("valid", geometry);
      item.style.mode = "categorized";
      item.style.category = {
        field: "land_use", otherColor: "#777777",
        categories: [{ value: "Forest", color: "#123456" }, { value: 1, color: "#ABCDEF" }, { value: true, color: "#654321" }],
      };
      item.style.label.enabled = true;
      item.style.label.field = "name";
      const specifications = vectorLayerSpecifications(item, true);
      expect(validateStyleMin({
        version: 8, sources: { "gis-valid": { type: "vector", tiles: ["https://portal.test/{z}/{x}/{y}.pbf"] } },
        layers: specifications,
      }).map((error) => error.message)).toEqual([]);
      const label = specifications.find((entry) => entry.type === "symbol")!;
      expect(label.layout).toMatchObject({
        "text-font": ["sans-serif"], "text-allow-overlap": false, "text-ignore-placement": false,
      });
      expect(label.layout?.["text-field"]).toContainEqual(["slice", ["to-string", ["get", "name"]], 0, 120]);
    },
  );

  it("retains independent polygon fill and outline opacity, width, and color", () => {
    const item = layer("boundary");
    Object.assign(item.style, { opacity: 0, strokeOpacity: 0.7, strokeWidth: 3, strokeColor: "#163A2B" });
    const [fill, outline] = vectorLayerSpecifications(item, true);
    expect(fill.paint).toMatchObject({ "fill-opacity": 0 });
    expect(outline.paint).toMatchObject({ "line-opacity": 0.7, "line-width": 3, "line-color": "#163A2B" });
  });

  it("executes labels as bounded scalar text without exposing nested properties or expressions", () => {
    const item = layer("labels");
    Object.assign(item.style.label, { enabled: true, field: "name" });
    const specification = vectorLayerSpecifications(item, true).find((entry) => entry.type === "symbol")!;
    // The bundled JSON spec widens string literals and omits paint-only transition metadata.
    const compiled = createExpression(specification.layout!["text-field"], "text-field", latest.layout_symbol["text-field"] as unknown as StylePropertySpecification);
    if (compiled.result === "error") throw new Error(JSON.stringify(compiled.value));
    const evaluate = (properties: Record<string, unknown>) => compiled.value.evaluateWithoutErrorHandling(
      { zoom: 14 }, { type: "Polygon", properties },
    ).toString();
    for (const value of ["Blok 名称", 0, false, '["get","private"]', "<script>literal</script>"]) {
      expect(evaluate({ name: value })).toBe(String(value));
    }
    for (const value of [null, [], { private: "hidden" }]) expect(evaluate({ name: value })).toBe("");
    expect(evaluate({})).toBe("");
    expect(evaluate({ name: "x".repeat(500) })).toBe("x".repeat(120));
  });

  it("preserves sources and existing layers while applying preview paints, labels, and zoom ranges", () => {
    const { map, render } = mapDouble();
    const item = layer("live");
    render([item]);
    map.addSource.mockClear();
    map.addLayer.mockClear();
    map.moveLayer.mockClear();
    Object.assign(item.style, { color: "#ABCDEF", opacity: 0.8, minZoom: 3, maxZoom: 19 });
    Object.assign(item.style.label, { enabled: true, field: "block_code", minZoom: 4, maxZoom: 18 });
    render([item]);
    expect(map.addSource).not.toHaveBeenCalled();
    expect(map.removeSource).not.toHaveBeenCalled();
    expect(map.addLayer).not.toHaveBeenCalled();
    expect(map.removeLayer).not.toHaveBeenCalled();
    expect(map.moveLayer).not.toHaveBeenCalled();
    expect(map.setPaintProperty).toHaveBeenCalledWith("gis-live", "fill-color", "#ABCDEF");
    expect(map.setLayoutProperty).toHaveBeenCalledWith("gis-live-label", "visibility", "visible");
    expect(map.setLayerZoomRange).toHaveBeenCalledWith("gis-live-label", 4, 18);
    map.setPaintProperty.mockClear();
    map.setLayoutProperty.mockClear();
    render([item]);
    expect(map.setPaintProperty).not.toHaveBeenCalled();
    expect(map.setLayoutProperty).not.toHaveBeenCalled();
  });

  it("resets line dash on a switch back to solid without recreating its source", () => {
    const { map, render } = mapDouble();
    const item = layer("road", "LineString");
    item.style.dash = "dashed";
    render([item]);
    item.style.dash = "solid";
    render([item]);
    expect(map.setPaintProperty).toHaveBeenCalledWith("gis-road", "line-dasharray", undefined);
    expect(map.addSource).toHaveBeenCalledTimes(1);
  });

  it("moves whole sublayer groups so the first catalog entry is topmost", () => {
    const { state, map, render } = mapDouble();
    const upper = layer("upper");
    const lower = layer("lower");
    render([upper, lower]);
    expect(state.layers.map((item) => item.id)).toEqual([
      "gis-lower", "gis-lower-outline", "gis-lower-label", "gis-upper", "gis-upper-outline", "gis-upper-label", "measure-fill",
    ]);
    map.addSource.mockClear();
    render([lower, upper]);
    expect(state.layers.map((item) => item.id)).toEqual([
      "gis-upper", "gis-upper-outline", "gis-upper-label", "gis-lower", "gis-lower-outline", "gis-lower-label", "measure-fill",
    ]);
    expect(map.addSource).not.toHaveBeenCalled();
    expect(map.removeSource).not.toHaveBeenCalled();
  });

  it("removes all sublayers before their source, preserving measurement and remaining data", () => {
    const { state, render } = mapDouble();
    const keep = layer("keep", "Point");
    render([keep, layer("deleted")]);
    expect(() => render([keep])).not.toThrow();
    expect(Object.keys(state.sources).sort()).toEqual(["gis-keep", "measurement"]);
    expect(state.layers.map((item) => item.id)).toEqual(["gis-keep", "gis-keep-label", "measure-fill"]);
  });

  it("uses global defaults only when local visibility is absent and hides non-overlapping label ranges", () => {
    const { state, render } = mapDouble();
    const item = layer("hidden");
    item.defaultVisible = false;
    Object.assign(item.style, { minZoom: 0, maxZoom: 8 });
    Object.assign(item.style.label, { enabled: true, field: "code", minZoom: 12, maxZoom: 20 });
    render([item]);
    expect(state.layers.filter((entry) => entry.id.startsWith("gis-")).every((entry) => entry.layout?.visibility === "none")).toBe(true);
    render([item], { hidden: true });
    expect(state.layers.find((entry) => entry.id === "gis-hidden")?.layout?.visibility).toBe("visible");
    expect(state.layers.find((entry) => entry.id === "gis-hidden-label")?.layout?.visibility).toBe("none");
    expect(item.defaultVisible).toBe(false);
  });
});
