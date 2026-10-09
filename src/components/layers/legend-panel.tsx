import { legendEntries } from "@/lib/gis/style";
import type { MapLayer } from "@/lib/gis/types";
import { LayerSymbol } from "./layer-symbol";
import styles from "./layer-panel.module.css";
export function LegendPanel({ layers }: { layers: MapLayer[] }) {
  return (
    <section className="gis-panel" aria-labelledby="legend-title">
      <h2 id="legend-title">Legend</h2>
      {layers.length ? <ul className={styles.legendLayers}>
        {layers.map((layer) => <li key={layer.id}>
          {layer.style.mode === "categorized" && <><strong className={styles.legendTitle}>{layer.name}</strong><span className={styles.legendNote}>{layer.style.category?.field}</span></>}
          <ul className={styles.legendList} aria-label={`Legend for ${layer.name}`}>
            {legendEntries(layer.style, layer.name).map((entry, index) => <li key={index}><LayerSymbol style={layer.style} color={entry.color} /><span>{entry.label}</span></li>)}
          </ul>
          {layer.style.label.enabled && <span className={styles.legendNote}>Labels: {layer.style.label.field} · zoom {layer.style.label.minZoom}–{layer.style.label.maxZoom}</span>}
        </li>)}
      </ul> : <p className="gis-help">Turn on a layer to see its legend.</p>}
    </section>
  );
}
