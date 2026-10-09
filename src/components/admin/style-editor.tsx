"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { LayerSymbol } from "@/components/layers/layer-symbol";
import { basemaps } from "@/lib/gis/basemaps";
import { defaultVectorStyle, legendEntries, validBounds, vectorStyleSchema, type VectorStyle } from "@/lib/gis/style";
import type { Coordinate, MapLayer } from "@/lib/gis/types";
import { gisRequest } from "./gis-requests";
import styles from "./style-editor.module.css";

const MapCanvas = dynamic(() => import("@/components/map/map-canvas"), { ssr: false, loading: () => <p className={styles.hint}>Loading map preview…</p> });
const noAction = () => {};
const noPoints: Coordinate[] = [];
const palette = ["#2F6B45", "#8B6F47", "#337AB7", "#E39A35", "#708238", "#885E9B", "#2A9690", "#B4534D"];
type StyleResponse = { layer: MapLayer; csrfToken: string };
type AttributeResponse = { fields: string[]; sampled: boolean };
type ValuesResponse = { values: Array<string | number | boolean>; truncated: boolean; sampled: boolean };
type Notice = { message: string; error?: boolean };

function ColorControl({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className={styles.field}>{label}<span className={styles.colorRow}><input type="color" aria-label={label} value={value} onChange={(event) => onChange(event.currentTarget.value.toUpperCase())} /><code aria-hidden="true">{value}</code></span></label>;
}

function NumberControl({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  function change(raw: string) {
    setEditing(raw);
    const next = Number(raw);
    if (raw !== "" && Number.isFinite(next) && next >= min && next <= max) onChange(next);
  }
  function finish(raw: string) {
    const next = Number(raw);
    if (raw !== "" && Number.isFinite(next)) onChange(Math.max(min, Math.min(max, next)));
    setEditing(null);
  }
  return <div className={styles.field}><span>{label}</span><div className={styles.numberRow}><input type="range" aria-label={`${label} slider`} min={min} max={max} step={step} value={value} onChange={(event) => { setEditing(null); onChange(Number(event.currentTarget.value)); }} /><input type="number" aria-label={label} min={min} max={max} step={step} value={editing ?? value} onChange={(event) => change(event.currentTarget.value)} onBlur={(event) => finish(event.currentTarget.value)} /></div></div>;
}

export function StyleEditor({ layerId }: { layerId: string }) {
  const [layer, setLayer] = useState<MapLayer | null>(null);
  const [draft, setDraft] = useState<VectorStyle | null>(null);
  const [saved, setSaved] = useState<VectorStyle | null>(null);
  const [fields, setFields] = useState<string[]>([]);
  const [fieldNotice, setFieldNotice] = useState("");
  const [categoryNotice, setCategoryNotice] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadingCategories, setLoadingCategories] = useState(false);
  const [coordinates, setCoordinates] = useState<Coordinate | null>(null);
  const [mapError, setMapError] = useState("");
  const [fitRevision, setFitRevision] = useState(0);
  const mounted = useRef(false);
  const categoryRequest = useRef<AbortController | null>(null);
  const saveRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    async function load() {
      try {
        const [style, attributes] = await Promise.allSettled([
          gisRequest<StyleResponse>(`/api/admin/layers/${layerId}/style`, { signal: controller.signal }),
          gisRequest<AttributeResponse>(`/api/admin/layers/${layerId}/attributes`, { signal: controller.signal }),
        ]);
        if (controller.signal.aborted) return;
        if (style.status === "rejected") throw style.reason;
        setLayer(style.value.layer); setDraft(style.value.layer.style); setSaved(style.value.layer.style);
        if (attributes.status === "fulfilled") {
          setFields(attributes.value.fields);
          setFieldNotice(attributes.value.sampled ? "Attributes are drawn from a bounded sample of this layer. Some fields may not appear." : "");
        } else setFieldNotice("Attributes could not be loaded. Reload this page to configure categories or labels.");
      } catch (error) {
        if (!controller.signal.aborted) setNotice({ error: true, message: error instanceof Error ? error.message : "This layer could not be opened." });
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void load();
    return () => { mounted.current = false; controller.abort(); categoryRequest.current?.abort(); saveRequest.current?.abort(); };
  }, [layerId]);

  const validation = useMemo(() => draft ? vectorStyleSchema.safeParse(draft) : null, [draft]);
  const previewLayers = useMemo(() => layer && draft && saved ? [{ ...layer, style: validation?.success ? validation.data : saved }] : [], [layer, draft, saved, validation]);
  const previewVisible = useMemo(() => ({ [layerId]: true }), [layerId]);
  const fit = useMemo(() => layer && validBounds(layer.bounds) ? { bounds: layer.bounds, revision: fitRevision } : null, [layer, fitRevision]);
  const dirty = draft !== null && saved !== null && JSON.stringify(draft) !== JSON.stringify(saved);

  function update(changes: Partial<VectorStyle>) { setDraft((current) => current ? { ...current, ...changes } : current); setNotice(null); }
  function updateLabel(changes: Partial<VectorStyle["label"]>) { setDraft((current) => current ? { ...current, label: { ...current.label, ...changes } } : current); setNotice(null); }
  function stopCategoryRequest() { categoryRequest.current?.abort(); categoryRequest.current = null; setLoadingCategories(false); setCategoryNotice(""); }

  async function chooseCategoryField(field: string) {
    stopCategoryRequest();
    const controller = new AbortController();
    categoryRequest.current = controller;
    setNotice(null);
    setDraft((current) => current ? { ...current, mode: "categorized", category: { field, categories: current.category?.field === field ? current.category.categories : [], otherColor: current.category?.otherColor ?? current.color } } : current);
    if (!field) return;
    setLoadingCategories(true);
    try {
      const result = await gisRequest<ValuesResponse>(`/api/admin/layers/${layerId}/attributes?field=${encodeURIComponent(field)}`, { signal: controller.signal });
      if (controller.signal.aborted || !mounted.current) return;
      setDraft((current) => {
        if (!current || current.mode !== "categorized" || current.category?.field !== field) return current;
        return { ...current, category: { ...current.category, categories: result.values.map((value, index) => ({ value, color: current.category!.categories.find((entry) => typeof entry.value === typeof value && entry.value === value)?.color ?? palette[index % palette.length] })) } };
      });
      setCategoryNotice(result.values.length === 0 ? "No usable values were found for this attribute. Choose another field or Single Symbol." : result.truncated || result.sampled ? "Showing up to 50 categories from a bounded sample. Other values use the fallback color." : `${result.values.length} categories found in this layer.`);
    } catch (error) {
      if (!controller.signal.aborted && mounted.current) setCategoryNotice(error instanceof Error ? error.message : "Category values could not be loaded. Please try again.");
    } finally { if (!controller.signal.aborted && mounted.current) setLoadingCategories(false); }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || busy || saveRequest.current || loadingCategories || !validation?.success) return;
    const controller = new AbortController();
    saveRequest.current = controller;
    setBusy(true); setNotice(null);
    try {
      const access = await gisRequest<StyleResponse>(`/api/admin/layers/${layerId}/style`, { signal: controller.signal });
      const result = await gisRequest<{ layer: MapLayer }>(`/api/admin/layers/${layerId}/style`, { method: "PUT", signal: controller.signal, headers: { "content-type": "application/json", "x-gis-csrf": access.csrfToken }, body: JSON.stringify({ style: validation.data }) });
      if (!mounted.current) return;
      setLayer(result.layer); setSaved(result.layer.style); setDraft(result.layer.style);
      setNotice({ message: "Layer style saved. This appearance is now shared with your team." });
    } catch (error) { if (mounted.current) setNotice({ error: true, message: error instanceof Error ? error.message : "The style could not be saved. Please try again." }); }
    finally { saveRequest.current = null; if (mounted.current) setBusy(false); }
  }

  if (loading) return <div className="gis-admin-panel approval-empty" role="status">Loading layer style…</div>;
  if (!layer || !draft || !saved) return <div className="notice notice-error" role="alert">{notice?.message ?? "This layer is unavailable for styling."}</div>;
  const fillName = draft.type === "polygon" ? "Fill" : draft.type === "point" ? "Circle" : "Line";
  const entries = legendEntries(previewLayers[0].style, layer.name);

  return <>
    {notice && <div className={`notice ${notice.error ? "notice-error" : "notice-success"} ${styles.banner}`} role={notice.error ? "alert" : "status"}>{notice.message}</div>}
    <div className={styles.editor}>
      <form className={styles.controls} aria-label="Layer style controls" onSubmit={(event) => void save(event)}>
        <h2>{layer.name}</h2><p className={styles.hint}>{layer.geometryType} · {layer.featureCount.toLocaleString("en-GB")} features · {dirty ? "Unsaved preview" : "Saved appearance"}</p>
        <fieldset disabled={busy}><legend>Symbol style</legend>
          <label className={styles.field}>Style type<select value={draft.mode} onChange={(event) => { if (event.currentTarget.value === "single") { stopCategoryRequest(); update({ mode: "single", category: null }); } else void chooseCategoryField(fields[0] ?? ""); }}><option value="single">Single Symbol</option><option value="categorized" disabled={!fields.length}>Categorized</option></select></label>
          {draft.mode === "single" ? <ColorControl label={`${fillName} color`} value={draft.color} onChange={(color) => update({ color })} /> : <>
            <label className={styles.field}>Category field<select value={draft.category?.field ?? ""} onChange={(event) => void chooseCategoryField(event.currentTarget.value)}><option value="">Select an attribute</option>{fields.map((field) => <option key={field} value={field}>{field}</option>)}</select></label>
            {loadingCategories && <p role="status" className={styles.hint}>Loading category values…</p>}
            {categoryNotice && <p className={styles.hint} role="status">{categoryNotice}</p>}
            <div className={styles.categories}>{draft.category?.categories.map((entry, index) => <ColorControl key={`${typeof entry.value}:${String(entry.value)}`} label={`Category color: ${legendEntries(draft, layer.name)[index].label}`} value={entry.color} onChange={(color) => update({ category: { ...draft.category!, categories: draft.category!.categories.map((item, i) => i === index ? { ...item, color } : item) } })} />)}</div>
            <ColorControl label="Other values color" value={draft.category?.otherColor ?? draft.color} onChange={(otherColor) => draft.category && update({ category: { ...draft.category, otherColor } })} />
          </>}
          <NumberControl label={`${fillName} opacity`} min={0} max={1} step={0.01} value={draft.opacity} onChange={(opacity) => update({ opacity })} />
          {draft.type === "line" && <><NumberControl label="Line width" min={0.5} max={20} step={0.5} value={draft.width} onChange={(width) => update({ width })} /><label className={styles.field}>Line style<select value={draft.dash} onChange={(event) => update({ dash: event.currentTarget.value as VectorStyle["dash"] })}><option value="solid">Solid</option><option value="dashed">Dashed</option><option value="dotted">Dotted</option></select></label></>}
          {draft.type === "point" && <NumberControl label="Circle radius" min={1} max={40} value={draft.radius} onChange={(radius) => update({ radius })} />}
          {draft.type !== "line" && <><ColorControl label={draft.type === "polygon" ? "Outline color" : "Stroke color"} value={draft.strokeColor} onChange={(strokeColor) => update({ strokeColor })} /><NumberControl label={draft.type === "polygon" ? "Outline width" : "Stroke width"} min={0} max={12} step={0.5} value={draft.strokeWidth} onChange={(strokeWidth) => update({ strokeWidth })} /><NumberControl label={draft.type === "polygon" ? "Outline opacity" : "Stroke opacity"} min={0} max={1} step={0.01} value={draft.strokeOpacity} onChange={(strokeOpacity) => update({ strokeOpacity })} /></>}
        </fieldset>
        <fieldset disabled={busy}><legend>Labels</legend>
          <label className={styles.checkbox}><input type="checkbox" checked={draft.label.enabled} disabled={!fields.length && !draft.label.enabled} onChange={(event) => updateLabel({ enabled: event.currentTarget.checked, field: draft.label.field ?? fields[0] ?? null })} />Enable labels</label>
          {fieldNotice && <p className={styles.hint}>{fieldNotice}</p>}
          {!fields.length && <p className={styles.hint}>No suitable attribute fields are available for categories or labels.</p>}
          {draft.label.enabled && <><label className={styles.field}>Label field<select value={draft.label.field ?? ""} onChange={(event) => updateLabel({ field: event.currentTarget.value || null })}><option value="">Select an attribute</option>{fields.map((field) => <option key={field} value={field}>{field}</option>)}</select></label><NumberControl label="Font size" min={8} max={48} value={draft.label.size} onChange={(size) => updateLabel({ size })} /><ColorControl label="Font color" value={draft.label.color} onChange={(color) => updateLabel({ color })} /><ColorControl label="Halo color" value={draft.label.haloColor} onChange={(haloColor) => updateLabel({ haloColor })} /><NumberControl label="Halo width" min={0} max={8} step={0.5} value={draft.label.haloWidth} onChange={(haloWidth) => updateLabel({ haloWidth })} /><NumberControl label="Label minimum zoom" min={0} max={24} value={draft.label.minZoom} onChange={(minZoom) => updateLabel({ minZoom })} /><NumberControl label="Label maximum zoom" min={0} max={24} value={draft.label.maxZoom} onChange={(maxZoom) => updateLabel({ maxZoom })} /><p className={styles.hint}>Labels use automatic placement and collision detection. Increase minimum zoom to keep dense areas readable.</p></>}
        </fieldset>
        <fieldset disabled={busy}><legend>Zoom visibility</legend><NumberControl label="Minimum zoom" min={0} max={24} value={draft.minZoom} onChange={(minZoom) => update({ minZoom })} /><NumberControl label="Maximum zoom" min={0} max={24} value={draft.maxZoom} onChange={(maxZoom) => update({ maxZoom })} /><p className={styles.hint}>Maximum zoom is exclusive. Set it above the highest zoom where the layer should appear.</p></fieldset>
        {validation && !validation.success && <p className={styles.error} role="alert">{validation.error.issues[0]?.message ?? "Check the style settings before saving."} The preview retains the saved appearance until the settings are valid.</p>}
        <div className={styles.actions}><button type="submit" className="button button-primary" disabled={busy || loadingCategories || !dirty || !validation?.success}>{busy ? "Saving…" : "Save Changes"}</button><button type="button" className="button button-quiet" disabled={busy} onClick={() => { stopCategoryRequest(); setDraft(defaultVectorStyle(layer.geometryType)); setNotice({ message: "Default style is shown in preview. Save Changes to apply it." }); }}>Reset to Default</button><button type="button" className="button button-quiet" disabled={busy} onClick={() => { stopCategoryRequest(); setDraft(saved); setNotice({ message: "Unsaved changes canceled. The saved style has been restored." }); }}>Cancel</button></div>
      </form>
      <section className={styles.preview} aria-label="Live style preview"><div className={styles.previewHeading}><div><h2>Live preview</h2><p>Changes stay in this preview until you save.</p></div><button type="button" className="button button-quiet" onClick={() => { if (validBounds(layer.bounds)) setFitRevision((value) => value + 1); else setMapError("This layer does not have a valid extent to zoom to."); }}>Zoom to Layer</button></div>
        {mapError && <p className={styles.error} role="alert">{mapError}</p>}
        <div className={`${styles.canvas} gis-workspace`} data-testid="style-preview-map"><MapCanvas layers={previewLayers} visible={previewVisible} basemap={basemaps[0]} mode="none" points={noPoints} finished={false} fit={fit} onPoint={noAction} onMovePoint={noAction} onCoordinates={setCoordinates} onError={setMapError} onUnauthorized={() => window.location.replace("/admin")} /></div>
        <div className={styles.coordinates}>{coordinates ? `${coordinates[0].toFixed(5)}, ${coordinates[1].toFixed(5)}` : "Move over the map to see coordinates"}</div>
        <div className={styles.legend} aria-label="Preview legend">{entries.map((entry, index) => <span key={`${entry.label}-${index}`}><LayerSymbol style={previewLayers[0].style} color={entry.color} />{entry.label}</span>)}</div>
      </section>
    </div>
  </>;
}
