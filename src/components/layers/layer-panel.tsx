"use client";
import type { MapLayer } from "@/lib/gis/types";
import { geometryFamily } from "@/lib/gis/types";
export function LayerPanel({
  layers,
  visible,
  onToggle,
  onFit,
}: {
  layers: MapLayer[];
  visible: Record<string, boolean>;
  onToggle: (id: string) => void;
  onFit: (layer: MapLayer) => void;
}) {
  return (
    <section className="gis-panel" aria-labelledby="layers-title">
      <div className="gis-panel-heading">
        <h2 id="layers-title">Layers</h2>
        <span>{layers.length} available</span>
      </div>
      <p className="gis-help">Choose the information shown on your map.</p>
      {layers.length === 0 && (
        <p className="gis-empty">No GIS layers available.</p>
      )}
      <div className="gis-layer-list">
        {layers.map((layer) => (
          <div className="gis-layer-item" key={layer.id}>
            <label>
              <input
                type="checkbox"
                checked={visible[layer.id] !== false}
                onChange={() => onToggle(layer.id)}
              />
              <span
                className={`gis-symbol symbol-${geometryFamily(layer.geometryType)}`}
                style={{ color: layer.style.color }}
                aria-hidden="true"
              />
              <span>
                <strong title={layer.description || layer.name}>{layer.name}</strong>
                <small>
                  {layer.geometryType} · {layer.featureCount} features
                  {!layer.isVisible ? " · Admin preview" : ""}
                </small>
              </span>
            </label>
            <button
              type="button"
              className="gis-icon-button"
              onClick={() => onFit(layer)}
              aria-label={`Zoom to ${layer.name}`}
              title="Zoom to layer"
            >
              ⌖
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
