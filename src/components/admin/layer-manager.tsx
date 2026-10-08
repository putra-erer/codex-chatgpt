"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { AdminLayer } from "@/lib/gis/admin";
import { apiMessage, gisRequest, pollGisJob } from "./gis-requests";

const dates = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" });
type Catalog = { layers: AdminLayer[]; csrfToken: string };

export function LayerManager({ initialLayers }: { initialLayers: AdminLayer[] }) {
  const [layers, setLayers] = useState(initialLayers);
  const [notice, setNotice] = useState<{ message: string; error?: boolean } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [deletion, setDeletion] = useState<{ jobId: string; layerId: string } | null>(null);
  const [monitor, setMonitor] = useState(0);
  const [canCheckAgain, setCanCheckAgain] = useState(false);
  const mounted = useRef(true);
  const token = useRef("");
  const refreshing = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const catalog = await gisRequest<Catalog>("/api/admin/layers");
      if (mounted.current) { setLayers(catalog.layers); token.current = catalog.csrfToken; }
    } finally { refreshing.current = false; }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const update = () => {
      if (document.visibilityState === "visible") void refresh().catch(() => {
        if (mounted.current) setNotice({ error: true, message: "The layer list could not be refreshed. Check your connection and try again." });
      });
    };
    update();
    const interval = setInterval(update, 10000);
    document.addEventListener("visibilitychange", update);
    return () => { mounted.current = false; clearInterval(interval); document.removeEventListener("visibilitychange", update); };
  }, [refresh]);

  useEffect(() => {
    if (!deletion) return;
    const controller = new AbortController();
    async function watch() {
      try {
        const result = await pollGisJob(deletion!.jobId, controller.signal, () => {});
        if (controller.signal.aborted) return;
        setCanCheckAgain(false); setBusyId(null); setDeletion(null);
        setNotice(result.status === "SUCCEEDED"
          ? { message: "Layer and its associated GIS data have been deleted." }
          : { error: true, message: apiMessage(result.error, "The layer could not be deleted. Refresh the list and try again.") });
        await refresh();
      } catch {
        if (!controller.signal.aborted) {
          setBusyId(null); setCanCheckAgain(true);
          setNotice({ error: true, message: "We could not confirm whether deletion has finished. Check its status before trying again." });
        }
      }
    }
    void watch();
    return () => controller.abort();
  }, [deletion, monitor, refresh]);

  async function csrf() {
    // Refresh the token before every mutation so a long-open page still works.
    const catalog = await gisRequest<Catalog>("/api/admin/layers");
    token.current = catalog.csrfToken;
    return token.current;
  }

  async function updateLayer(layer: AdminLayer, changes: { name?: string; description?: string; isVisible?: boolean }) {
    if (busyId) return;
    setBusyId(layer.id); setNotice(null);
    try {
      const csrfToken = await csrf();
      const updated = await gisRequest<{ layer: AdminLayer }>(`/api/admin/layers/${layer.id}`, {
        method: "PATCH", headers: { "content-type": "application/json", "x-gis-csrf": csrfToken },
        body: JSON.stringify({ name: layer.name, description: layer.description, isVisible: layer.isVisible, ...changes }),
      });
      if (!mounted.current) return;
      setLayers((previous) => previous.map((item) => item.id === layer.id ? updated.layer : item));
      setEditing(null);
      setNotice({ message: "Layer details saved. The map will pick up the change when its layers refresh." });
    } catch (error) {
      if (mounted.current) setNotice({ error: true, message: error instanceof Error ? error.message : "The layer could not be updated. Please try again." });
    } finally { if (mounted.current) setBusyId(null); }
  }

  async function deleteLayer(layer: AdminLayer) {
    if (busyId || !window.confirm(`Delete “${layer.name}”? This permanently removes the layer and its associated GIS data. This cannot be undone.`)) return;
    setBusyId(layer.id); setNotice(null); setCanCheckAgain(false);
    try {
      const csrfToken = await csrf();
      const result = await gisRequest<{ jobId: string; layerId: string }>(`/api/admin/layers/${layer.id}`, {
        method: "DELETE", headers: { "x-gis-csrf": csrfToken },
      });
      if (!mounted.current) return;
      setLayers((previous) => previous.map((item) => item.id === layer.id ? { ...item, state: "DELETING" } : item));
      setEditing(null); setDeletion(result);
      setNotice({ message: "Deleting the layer and its associated GIS data…" });
    } catch (error) {
      if (mounted.current) { setBusyId(null); setNotice({ error: true, message: error instanceof Error ? error.message : "The layer could not be deleted. Please try again." }); }
    }
  }

  function save(event: FormEvent<HTMLFormElement>, layer: AdminLayer) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    if (!name) { setNotice({ error: true, message: "Enter a name for the layer." }); return; }
    void updateLayer(layer, { name, description: String(data.get("description") ?? "").trim() });
  }

  return (
    <section className="gis-admin-panel" aria-label="Manage GIS layers">
      <div className="gis-admin-heading"><div><h2>Layer catalog</h2><p className="muted">{layers.length} {layers.length === 1 ? "layer" : "layers"} · Only ready, visible layers are shared with viewers.</p></div><button className="button button-quiet" type="button" disabled={Boolean(busyId)} onClick={() => void refresh().then(() => setNotice(null)).catch(() => setNotice({ error: true, message: "The list could not be refreshed. Please try again." }))}>Refresh layers</button></div>
      {notice && <div className={`notice gis-admin-notice ${notice.error ? "notice-error" : "notice-success"}`} role={notice.error ? "alert" : "status"}>
        <p>{notice.message}</p>
        {canCheckAgain && deletion && <button type="button" className="button button-quiet" onClick={() => { setBusyId(deletion.layerId); setCanCheckAgain(false); setMonitor((value) => value + 1); }}>Check deletion status</button>}
      </div>}
      {layers.length === 0 ? <div className="approval-empty"><h3>No GIS layers available.</h3><p className="muted">Upload a shapefile to add your first layer to the map.</p><Link href="/admin/upload" className="button button-primary">Upload shapefile</Link></div> : <div className="gis-admin-table-scroll"><table className="gis-admin-table">
        <caption className="approval-sr-only">GIS layers, publication status and management actions</caption>
        <thead><tr><th scope="col">Layer</th><th scope="col">Geometry</th><th scope="col">Features</th><th scope="col">CRS</th><th scope="col">Visibility</th><th scope="col">Status</th><th scope="col">Uploaded</th><th scope="col">Actions</th></tr></thead>
        <tbody>{layers.map((layer) => <tr key={layer.id} data-layer-id={layer.id}>
          <td className="gis-admin-layer-name"><strong>{layer.name}</strong><p>{layer.description || "No description"}</p><small>{layer.layerType} · {layer.sourceType}</small>
            {editing === layer.id && <form onSubmit={(event) => save(event, layer)} className="gis-layer-edit"><label>Layer name<input name="name" defaultValue={layer.name} required maxLength={200} disabled={Boolean(busyId)} /></label><label>Description<textarea name="description" defaultValue={layer.description ?? ""} maxLength={2000} rows={3} disabled={Boolean(busyId)} /></label><div className="gis-admin-actions"><button className="button button-primary" type="submit" disabled={Boolean(busyId)}>{busyId === layer.id ? "Saving…" : "Save changes"}</button><button className="button button-quiet" type="button" disabled={Boolean(busyId)} onClick={() => setEditing(null)}>Cancel</button></div></form>}
          </td>
          <td>{layer.geometryType ?? "—"}</td><td>{layer.featureCount?.toLocaleString("en-GB") ?? "—"}</td><td>{layer.srid ? `EPSG:${layer.srid}` : "—"}</td>
          <td><label className="gis-admin-checkbox"><input type="checkbox" checked={layer.isVisible} disabled={Boolean(busyId) || layer.state !== "READY" || !layer.managed} onChange={(event) => void updateLayer(layer, { isVisible: event.currentTarget.checked })} aria-label={`Visible to viewers: ${layer.name}`} />{layer.isVisible ? "Visible" : "Hidden"}</label></td>
          <td><span className={`status-badge gis-state-${layer.state.toLowerCase()}`}>{layer.state}</span></td>
          <td><time dateTime={layer.createdAt}>{dates.format(new Date(layer.createdAt))} WIB</time><small>{layer.uploadedBy ? `${layer.uploadedBy.name || "Administrator"} (${layer.uploadedBy.email})` : "—"}</small></td>
          <td><div className="gis-admin-actions gis-layer-actions">
            {layer.state === "READY" && <Link className="button button-quiet" href={`/map?layer=${layer.id}`}>View on map</Link>}
            <button className="button button-quiet" type="button" disabled={Boolean(busyId) || layer.state !== "READY" || !layer.managed} onClick={() => setEditing(editing === layer.id ? null : layer.id)}>Edit details</button>
            <button className="button button-danger" type="button" disabled={Boolean(busyId) || !layer.managed || !["READY", "FAILED", "DELETING"].includes(layer.state)} onClick={() => void deleteLayer(layer)}>{busyId === layer.id && deletion ? "Deleting…" : layer.state === "DELETING" ? "Check / retry delete" : "Delete"}</button>
          </div>{!layer.managed && <small className="muted">Managed outside this portal</small>}</td>
        </tr>)}</tbody>
      </table></div>}
    </section>
  );
}
