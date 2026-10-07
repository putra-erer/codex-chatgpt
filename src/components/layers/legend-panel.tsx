import type { MapLayer } from "@/lib/gis/types";
export function LegendPanel({ layers }: { layers: MapLayer[] }) {
  return (
    <section className="gis-panel" aria-labelledby="legend-title">
      <h2 id="legend-title">Legend</h2>
      {layers.length ? (
        <ul className="gis-legend">
          {layers.map((layer) => (
            <li key={layer.id}>
              <span
                className={`gis-symbol symbol-${layer.geometryType}`}
                style={{
                  color: layer.style.color,
                  opacity: Math.max(0.5, layer.style.opacity),
                }}
                aria-hidden="true"
              />
              <span>{layer.name}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="gis-help">Turn on a layer to see its legend.</p>
      )}
    </section>
  );
}
