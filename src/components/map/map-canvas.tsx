"use client";
import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, Map as LibreMap, Marker } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import { geometryFamily } from "@/lib/gis/types";
import type {
  Basemap,
  Bounds,
  Coordinate,
  MapLayer,
  MeasureMode,
} from "@/lib/gis/types";
import "maplibre-gl/dist/maplibre-gl.css";

type Props = {
  layers: MapLayer[];
  visible: Record<string, boolean>;
  basemap: Basemap;
  mode: MeasureMode;
  points: Coordinate[];
  finished: boolean;
  fit: { bounds: Bounds; revision: number } | null;
  onPoint: (point: Coordinate) => void;
  onMovePoint: (index: number, point: Coordinate) => void;
  onCoordinates: (coordinate: Coordinate | null) => void;
  onError: (message: string) => void;
  onUnauthorized: () => void;
};
const sourceId = (id: string) => `gis-${id}`;
function addLayer(map: LibreMap, layer: MapLayer) {
  const id = sourceId(layer.id);
  if (map.getSource(id)) return;
  map.addSource(id, {
    type: "vector",
    tiles: [
      `${window.location.origin}/api/layers/${layer.id}/tiles/{z}/{x}/{y}.pbf`,
    ],
    minzoom: 0,
    maxzoom: 18,
  });
  const base = { id, source: id, "source-layer": "features" };
  if (geometryFamily(layer.geometryType) === "Point")
    map.addLayer(
      {
        ...base,
        type: "circle",
        paint: {
          "circle-radius": layer.style.radius,
          "circle-color": layer.style.color,
          "circle-opacity": layer.style.opacity,
          "circle-stroke-color": "#fff",
          "circle-stroke-width": 2,
        },
      },
      "measure-fill",
    );
  else if (geometryFamily(layer.geometryType) === "LineString")
    map.addLayer(
      {
        ...base,
        type: "line",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": layer.style.color,
          "line-width": layer.style.width,
          "line-opacity": layer.style.opacity,
        },
      },
      "measure-fill",
    );
  else
    map.addLayer(
      {
        ...base,
        type: "fill",
        paint: {
          "fill-color": layer.style.color,
          "fill-opacity": layer.style.opacity,
          "fill-outline-color": layer.style.color,
        },
      },
      "measure-fill",
    );
}
function popupContent(layer: MapLayer, properties: Record<string, unknown>) {
  const content = document.createElement("div");
  content.className = "gis-popup";
  const title = document.createElement("h3");
  title.textContent = layer.name;
  content.append(title);
  const list = document.createElement("dl");
  const reserved = /^(?:_.*|geom(?:etry)?|wkb_geometry|ogc_fid|gid|fid|table_name|file_path|storage_metadata|uploaded_by|source_srid|source_crs_wkt|.*(?:password|secret|token|credential|connection_string))$/i;
  for (const [key, value] of Object.entries(properties).filter(([key]) => !reserved.test(key)).slice(0, 30)) {
    const name = document.createElement("dt"),
      item = document.createElement("dd");
    name.textContent = key;
    item.textContent = String(value ?? "—").slice(0, 1000);
    list.append(name, item);
  }
  content.append(list);
  if (!list.childElementCount) {
    const empty = document.createElement("p");
    empty.textContent = "No attributes available.";
    content.append(empty);
  }
  return content;
}
export default function MapCanvas(props: Props) {
  const container = useRef<HTMLDivElement>(null),
    instance = useRef<LibreMap | null>(null);
  const latest = useRef(props);
  const markers = useRef<Marker[]>([]);
  const popup = useRef<maplibregl.Popup | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    latest.current = props;
  });
  useEffect(() => {
    if (!container.current) return;
    let map: LibreMap;
    try {
      maplibregl.setWorkerUrl(
        `/vendor/maplibre/worker.mjs?v=${maplibregl.getVersion()}`,
      );
      map = new maplibregl.Map({
        container: container.current,
        center: [0, 0],
        zoom: 1,
        maxZoom: 20,
        style: {
          version: 8,
          sources: {},
          layers: [
            {
              id: "canvas",
              type: "background",
              paint: { "background-color": "#e8eff0" },
            },
          ],
        },
        attributionControl: { compact: true },
        maxPitch: 0,
        renderWorldCopies: false,
        transformRequest: (url) =>
          url.startsWith("https://tile.openstreetmap.org/")
            ? { url, referrerPolicy: "strict-origin-when-cross-origin" }
            : { url },
      });
    } catch {
      latest.current.onError(
        "The map could not start. Enable WebGL/hardware acceleration in your browser and reload.",
      );
      return;
    }
    instance.current = map;
    map.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      "top-right",
    );
    map.addControl(
      new maplibregl.FullscreenControl({
        container: container.current.closest(".gis-workspace") as HTMLElement,
      }),
      "top-right",
    );
    map.addControl(
      new maplibregl.ScaleControl({ maxWidth: 140, unit: "metric" }),
      "bottom-left",
    );
    map.on("load", () => {
      map.addSource("measurement", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "measure-fill",
        source: "measurement",
        type: "fill",
        filter: ["==", "$type", "Polygon"],
        paint: { "fill-color": "#e34e68", "fill-opacity": 0.18 },
      });
      map.addLayer({
        id: "measure-line",
        source: "measurement",
        type: "line",
        filter: ["!=", "$type", "Point"],
        paint: {
          "line-color": "#c53755",
          "line-width": 3,
          "line-dasharray": [2, 1],
        },
      });
      setReady(true);
    });
    map.on("mousemove", (event) =>
      latest.current.onCoordinates([event.lngLat.lng, event.lngLat.lat]),
    );
    map.on("mouseout", () => latest.current.onCoordinates(null));
    map.on("click", (event) => {
      const current = latest.current;
      if (current.mode !== "none") {
        if (!current.finished)
          current.onPoint([event.lngLat.lng, event.lngLat.lat]);
        return;
      }
      const ids = current.layers
        .filter(
          (layer) =>
            current.visible[layer.id] !== false &&
            map.getLayer(sourceId(layer.id)),
        )
        .map((layer) => sourceId(layer.id));
      if (!ids.length) return;
      const hit = map.queryRenderedFeatures(event.point, { layers: ids })[0];
      if (!hit) return;
      const layer = current.layers.find(
        (layer) => sourceId(layer.id) === hit.layer.id,
      );
      if (!layer) return;
      popup.current?.remove();
      popup.current = new maplibregl.Popup({ maxWidth: "300px" })
        .setLngLat(event.lngLat)
        .setDOMContent(popupContent(layer, hit.properties))
        .addTo(map);
    });
    map.on("error", (event) => {
      const status = "status" in event.error ? event.error.status : null;
      if (status === 401 || status === 403) latest.current.onUnauthorized();
      else
        latest.current.onError(
          "Some map data could not load. Check your connection or switch to a canvas basemap, then retry.",
        );
    });
    const resize = new ResizeObserver(() => map.resize());
    resize.observe(container.current);
    return () => {
      resize.disconnect();
      markers.current.forEach((marker) => marker.remove());
      popup.current?.remove();
      map.remove();
      instance.current = null;
    };
  }, []);
  useEffect(() => {
    const map = instance.current;
    if (!ready || !map) return;
    popup.current?.remove();
    const wanted = new Set(props.layers.map((layer) => sourceId(layer.id)));
    for (const layer of map.getStyle().layers ?? [])
      if (layer.id.startsWith("gis-") && !wanted.has(layer.id)) {
        map.removeLayer(layer.id);
        map.removeSource(layer.id);
      }
    for (const layer of props.layers) {
      addLayer(map, layer);
      map.setLayoutProperty(
        sourceId(layer.id),
        "visibility",
        props.visible[layer.id] === false ? "none" : "visible",
      );
    }
  }, [ready, props.layers, props.visible]);
  useEffect(() => {
    const map = instance.current;
    if (!ready || !map) return;
    if (map.getLayer("basemap")) map.removeLayer("basemap");
    if (map.getSource("basemap")) map.removeSource("basemap");
    map.setPaintProperty(
      "canvas",
      "background-color",
      props.basemap.background,
    );
    if (props.basemap.tiles) {
      map.addSource("basemap", {
        type: "raster",
        tiles: props.basemap.tiles,
        tileSize: 256,
        maxzoom: props.basemap.maxZoom,
        attribution: props.basemap.attribution,
      });
      map.addLayer(
        { id: "basemap", source: "basemap", type: "raster" },
        map.getStyle().layers?.[1]?.id,
      );
    }
  }, [ready, props.basemap]);
  useEffect(() => {
    const map = instance.current;
    if (!ready || !map) return;
    map.getCanvas().style.cursor = props.mode === "none" ? "" : "crosshair";
    if (props.mode !== "none") {
      popup.current?.remove();
      map.doubleClickZoom.disable();
    } else map.doubleClickZoom.enable();
    const data: FeatureCollection = { type: "FeatureCollection", features: [] };
    if (props.points.length >= 2)
      data.features.push({
        type: "Feature",
        properties: {},
        geometry:
          props.mode === "polygon" && props.points.length >= 3
            ? {
                type: "Polygon",
                coordinates: [[...props.points, props.points[0]]],
              }
            : { type: "LineString", coordinates: props.points },
      });
    (map.getSource("measurement") as GeoJSONSource).setData(data);
    markers.current.forEach((marker) => marker.remove());
    markers.current = props.points.map((point, index) => {
      const element = document.createElement("button");
      element.type = "button";
      element.className = "gis-measure-point";
      element.textContent = String(index + 1);
      element.setAttribute(
        "aria-label",
        `Measurement point ${index + 1}; drag to adjust`,
      );
      element.addEventListener("click", (event) => event.stopPropagation());
      const marker = new maplibregl.Marker({ element, draggable: true })
        .setLngLat(point)
        .addTo(map);
      marker.on("dragend", () => {
        const pos = marker.getLngLat();
        latest.current.onMovePoint(index, [pos.lng, pos.lat]);
      });
      return marker;
    });
  }, [ready, props.mode, props.points]);
  useEffect(() => {
    if (ready && props.fit)
      instance.current?.fitBounds(
        [
          [props.fit.bounds[0], props.fit.bounds[1]],
          [props.fit.bounds[2], props.fit.bounds[3]],
        ],
        { padding: 55, maxZoom: 16, duration: 600 },
      );
  }, [ready, props.fit]);
  return (
    <div
      className="gis-map-canvas"
      ref={container}
      aria-label="Interactive GIS map"
      data-map-ready={ready}
    />
  );
}
