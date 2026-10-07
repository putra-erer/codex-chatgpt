"use client";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import { LayerPanel } from "@/components/layers/layer-panel";
import { LegendPanel } from "@/components/layers/legend-panel";
import { BasemapPanel } from "./basemap-panel";
import { MeasurementPanel } from "./measurement-panel";
import {
  formatArea,
  formatLength,
  lineMeters,
  polygonSquareMeters,
} from "@/lib/gis/measurement";
import type {
  AreaUnit,
  Basemap,
  Bounds,
  Coordinate,
  LengthUnit,
  MapLayer,
  MeasureMode,
} from "@/lib/gis/types";

// MapLibre touches browser APIs; this boundary explicitly disables its server rendering.
const MapCanvas = dynamic(() => import("./map-canvas"), {
  ssr: false,
  loading: () => (
    <div className="gis-map-loading" role="status">
      Preparing your map…
    </div>
  ),
});
const demoBounds: Bounds = [106.809, -6.22, 106.854, -6.16];
export function GISViewer() {
  const [layers, setLayers] = useState<MapLayer[]>([]),
    [basemaps, setBasemaps] = useState<Basemap[]>([]);
  const [visible, setVisible] = useState<Record<string, boolean>>({}),
    [basemapId, setBasemapId] = useState("light");
  const [loading, setLoading] = useState(true),
    [error, setError] = useState<string | null>(null),
    [retry, setRetry] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true),
    [coordinate, setCoordinate] = useState<Coordinate | null>(null);
  const [mode, setMode] = useState<MeasureMode>("none"),
    [points, setPoints] = useState<Coordinate[]>([]),
    [finished, setFinished] = useState(false);
  const [lengthUnit, setLengthUnit] = useState<LengthUnit>("m"),
    [areaUnit, setAreaUnit] = useState<AreaUnit>("ha");
  const [fit, setFit] = useState<{ bounds: Bounds; revision: number }>({
    bounds: demoBounds,
    revision: 0,
  });
  const [revoked, setRevoked] = useState(false);
  const unauthorized = useCallback(() => {
    setRevoked(true);
    window.location.replace("/map");
  }, []);
  useEffect(() => {
    let stopped = false,
      active = false;
    const controller = new AbortController();
    async function load() {
      if (active || document.visibilityState !== "visible") return;
      active = true;
      try {
        const responses = await Promise.all([
          fetch("/api/layers", {
            cache: "no-store",
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(15000),
            ]),
          }),
          fetch("/api/basemaps", {
            cache: "no-store",
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(15000),
            ]),
          }),
        ]);
        if (stopped) return;
        if (
          responses.some(
            (response) => response.status === 401 || response.status === 403,
          )
        ) {
          unauthorized();
          return;
        }
        if (responses.some((response) => !response.ok))
          throw new Error("Unavailable");
        const [catalog, maps] = await Promise.all(
          responses.map((response) => response.json()),
        );
        if (stopped) return;
        setLayers((previous) =>
          JSON.stringify(previous) === JSON.stringify(catalog.layers)
            ? previous
            : catalog.layers,
        );
        setBasemaps((previous) =>
          JSON.stringify(previous) === JSON.stringify(maps.basemaps)
            ? previous
            : maps.basemaps,
        );
      } catch {
        if (!stopped)
          setError(
            "Map data could not be refreshed. Check your connection and try again.",
          );
      } finally {
        active = false;
        if (!stopped) setLoading(false);
      }
    }
    void load();
    const interval = setInterval(() => void load(), 30000);
    const refresh = () => void load();
    document.addEventListener("visibilitychange", refresh);
    return () => {
      stopped = true;
      controller.abort();
      clearInterval(interval);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [retry, unauthorized]);
  function chooseMode(next: MeasureMode) {
    setMode(next);
    setPoints([]);
    setFinished(false);
    if (next !== "none") setSidebarOpen(true);
  }
  function addPoint(point: Coordinate) {
    setPoints((previous) =>
      previous.length >= 200 ? previous : [...previous, point],
    );
  }
  const base = basemaps.find((item) => item.id === basemapId) ?? basemaps[0];
  const shown = layers.filter((layer) => visible[layer.id] !== false);
  const measurement =
    mode === "polygon"
      ? formatArea(polygonSquareMeters(points), areaUnit)
      : formatLength(lineMeters(points), lengthUnit);
  if (revoked)
    return <div className="gis-map-loading">Checking your access…</div>;
  return (
    <div className={`gis-workspace ${sidebarOpen ? "" : "sidebar-collapsed"}`}>
      <div className="gis-toolbar">
        <button
          type="button"
          className="gis-tool sidebar-toggle"
          aria-expanded={sidebarOpen}
          aria-controls="gis-sidebar"
          onClick={() => setSidebarOpen(!sidebarOpen)}
        >
          {sidebarOpen ? "Hide panels" : "Show panels"}
        </button>
        <div className="gis-toolbar-title">
          <h1>GIS Viewer</h1>
          <span>Jakarta · Demo workspace</span>
        </div>
        <div className="gis-tools" role="group" aria-label="Map tools">
          <button
            type="button"
            className={`gis-tool ${mode === "none" ? "active" : ""}`}
            aria-pressed={mode === "none"}
            onClick={() => chooseMode("none")}
          >
            Explore
          </button>
          <button
            type="button"
            className={`gis-tool ${mode === "line" ? "active" : ""}`}
            aria-pressed={mode === "line"}
            onClick={() => chooseMode("line")}
          >
            Line
          </button>
          <button
            type="button"
            className={`gis-tool ${mode === "polygon" ? "active" : ""}`}
            aria-pressed={mode === "polygon"}
            onClick={() => chooseMode("polygon")}
          >
            Area
          </button>
          <button
            type="button"
            className="gis-tool"
            onClick={() =>
              setFit((previous) => ({
                bounds: demoBounds,
                revision: previous.revision + 1,
              }))
            }
          >
            Reset view
          </button>
        </div>
      </div>
      <div className="gis-body">
        <aside
          id="gis-sidebar"
          className="gis-sidebar"
          aria-label="GIS panels"
          hidden={!sidebarOpen}
        >
          <div className="gis-sidebar-intro">
            <span className="eyebrow">Workspace data</span>
            <p>
              Synthetic layers to explore the viewer. Click a feature to see its
              attributes.
            </p>
          </div>
          <LayerPanel
            layers={layers}
            visible={visible}
            onToggle={(id) =>
              setVisible((previous) => ({
                ...previous,
                [id]: previous[id] === false,
              }))
            }
            onFit={(layer) =>
              setFit((previous) => ({
                bounds: layer.bounds,
                revision: previous.revision + 1,
              }))
            }
          />
          <MeasurementPanel
            mode={mode}
            points={points}
            lengthUnit={lengthUnit}
            areaUnit={areaUnit}
            finished={finished}
            onLengthUnit={setLengthUnit}
            onAreaUnit={setAreaUnit}
            onUndo={() => setPoints((previous) => previous.slice(0, -1))}
            onClear={() => {
              setPoints([]);
              setFinished(false);
            }}
            onFinish={() => setFinished(!finished)}
            onRemove={(index) =>
              setPoints((previous) => previous.filter((_, i) => i !== index))
            }
          />
          <BasemapPanel
            basemaps={basemaps}
            selected={basemapId}
            onSelect={(id) => {
              setBasemapId(id);
              setError(null);
            }}
          />
          <LegendPanel layers={shown} />
          <div className="gis-sidebar-foot">
            WGS 84 · EPSG:4326
            <br />
            Demo data is illustrative, not surveyed.
          </div>
        </aside>
        <section className="gis-map-stage" aria-label="Map workspace">
          {base && (
            <MapCanvas
              key={retry}
              layers={layers}
              visible={visible}
              basemap={base}
              mode={mode}
              points={points}
              finished={finished}
              fit={fit}
              onPoint={addPoint}
              onMovePoint={(index, point) =>
                setPoints((previous) =>
                  previous.map((item, i) => (i === index ? point : item)),
                )
              }
              onCoordinates={setCoordinate}
              onError={setError}
              onUnauthorized={unauthorized}
            />
          )}
          {loading && (
            <div className="gis-map-loading" role="status">
              Loading GIS workspace…
            </div>
          )}
          {error && (
            <div className="gis-map-notice" role="alert">
              <span>{error}</span>
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setRetry((previous) => previous + 1);
                }}
              >
                Retry
              </button>
            </div>
          )}
          <div className="gis-map-label">
            <span className="badge-dot" />
            {shown.length} visible layers
            <span className="gis-demo-tag">DEMO</span>
          </div>
          {mode !== "none" && (
            <div className="gis-measure-floating">
              <strong>
                {mode === "polygon" ? "Area" : "Distance"}: {measurement}
              </strong>
              <span>
                {points.length} / 200 points ·{" "}
                {finished ? "Drag points to adjust" : "Click to add points"}
              </span>
            </div>
          )}
          <div className="gis-coordinate-bar">
            <span>
              {coordinate
                ? `Lng ${coordinate[0].toFixed(5)}° · Lat ${coordinate[1].toFixed(5)}°`
                : "Move your pointer over the map"}
            </span>
            <span>WGS 84</span>
          </div>
        </section>
      </div>
    </div>
  );
}
