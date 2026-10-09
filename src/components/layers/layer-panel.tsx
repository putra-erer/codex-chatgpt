"use client";
import Link from "next/link";
import { useState } from "react";
import { legendEntries } from "@/lib/gis/style";
import type { MapLayer } from "@/lib/gis/types";
import { LayerSymbol } from "./layer-symbol";
import styles from "./layer-panel.module.css";

export function LayerPanel({ layers, visible, onToggle, onFit, onResetVisibility, isAdmin = false, loading = false }: {
  layers: MapLayer[];
  visible: Record<string, boolean>;
  onToggle: (id: string) => void;
  onFit: (layer: MapLayer) => void;
  onResetVisibility: () => void;
  isAdmin?: boolean;
  loading?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const query = search.trim().toLocaleLowerCase();
  const filtered = layers.filter((layer) => layer.name.toLocaleLowerCase().includes(query));
  const groups = new Map<string | null, MapLayer[]>();
  for (const layer of filtered) {
    const groupName = layer.groupName ?? null;
    const group = groups.get(groupName) ?? [];
    group.push(layer);
    groups.set(groupName, group);
  }
  return (
    <section className="gis-panel" aria-labelledby="layers-title" aria-busy={loading}>
      <div className="gis-panel-heading"><h2 id="layers-title">Layers</h2><span>{layers.length} available</span></div>
      <p className="gis-help">Choose the information shown on your map.</p>
      <label className={styles.search}>Search layers<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a layer by name" maxLength={200} /></label>
      <div className={styles.topActions}>
        <button type="button" className={styles.reset} disabled={!layers.length} onClick={onResetVisibility}>Use default visibility</button>
        {isAdmin && <Link href="/admin/layers">Layer Management</Link>}
      </div>
      {loading ? <p className="gis-help" role="status">Loading layers…</p> : layers.length === 0 ? <p className="gis-empty">No GIS layers available.</p> : filtered.length === 0 ? <p className="gis-empty" role="status">No layers match your search.</p> : null}
      <div className={styles.groups}>
        {[...groups].map(([name, group]) => {
          const key = name === null ? "ungrouped" : `group:${name}`;
          const groupName = name ?? "Ungrouped";
          const expanded = !collapsed[key] || Boolean(query);
          return <div key={key} className={styles.group}>
            <button type="button" className={styles.groupButton} aria-expanded={expanded} aria-label={`${expanded ? "Collapse" : "Expand"} group ${groupName}`} onClick={() => { if (query) setSearch(""); setCollapsed((previous) => ({ ...previous, [key]: expanded })); }}>
              <span aria-hidden="true">{expanded ? "▾" : "▸"}</span><span className={styles.groupName}>{groupName}</span><span className={styles.count}>{group.length} layers</span>
            </button>
            <div hidden={!expanded}>
              {group.map((layer) => <div key={layer.id} className={styles.entry} data-visible={visible[layer.id] ?? layer.defaultVisible}>
                <div className="gis-layer-item">
                  <label>
                    <input type="checkbox" aria-label={layer.name} checked={visible[layer.id] ?? layer.defaultVisible} onChange={() => onToggle(layer.id)} />
                    <LayerSymbol style={layer.style} />
                    <span><strong title={layer.description || layer.name}>{layer.name}</strong><small>{layer.geometryType} · {layer.featureCount.toLocaleString()} features{!layer.isVisible ? " · Admin preview" : ""}</small></span>
                  </label>
                  <button type="button" className="gis-icon-button" onClick={() => onFit(layer)} aria-label={`Zoom to ${layer.name}`} title="Zoom to layer">⌖</button>
                </div>
                <details className={styles.details}>
                  <summary aria-label={`Details and legend for ${layer.name}`}>Details &amp; legend</summary>
                  {layer.description && <p>{layer.description}</p>}
                  <dl><dt>Style</dt><dd>{layer.style.mode === "categorized" ? "Categorized" : "Single symbol"}</dd><dt>Zoom range</dt><dd>{layer.style.minZoom}–{layer.style.maxZoom}</dd><dt>Labels</dt><dd>{layer.style.label.enabled ? layer.style.label.field : "Off"}</dd><dt>Default visibility</dt><dd>{layer.defaultVisible ? "Visible" : "Hidden"}</dd></dl>
                  <ul className={styles.legendList} aria-label={`Legend for ${layer.name}`}>
                    {legendEntries(layer.style, layer.name).map((entry, index) => <li key={index}><LayerSymbol style={layer.style} color={entry.color} /><span>{entry.label}</span></li>)}
                  </ul>
                  {isAdmin && <div className={styles.adminLinks}><Link href={`/admin/layers/${layer.id}/style`}>Edit Style</Link><Link href={`/admin/layers#layer-${layer.id}`}>Edit Metadata</Link></div>}
                </details>
              </div>)}
            </div>
          </div>;
        })}
      </div>
      {layers.length > 0 && <p className={styles.notice}>Visibility changes apply only to your browser session. Use default visibility to restore the administrator’s settings.</p>}
    </section>
  );
}
