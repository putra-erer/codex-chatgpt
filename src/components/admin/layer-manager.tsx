"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { AdminLayer } from "@/lib/gis/admin";
import { apiMessage, gisRequest, pollGisJob } from "./gis-requests";
import styles from "./layer-manager.module.css";

const dates = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" });
type Catalog = { layers: AdminLayer[]; csrfToken: string };

export function LayerManager({ initialLayers }: { initialLayers: AdminLayer[] }) {
  const [layers, setLayers] = useState(initialLayers);
  const [notice, setNotice] = useState<{ message: string; error?: boolean } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [deletion, setDeletion] = useState<{ jobId: string; layerId: string } | null>(null);
  const [monitor, setMonitor] = useState(0);
  const [canCheckAgain, setCanCheckAgain] = useState(false);
  const mounted = useRef(true);
  const token = useRef("");
  const refreshing = useRef(false);
  const mutation = useRef(false);
  const catalogRevision = useRef(0);
  const initialHashHandled = useRef(false);
  const groups = useMemo(() => [...new Set(layers.flatMap((layer) => layer.groupName ? [layer.groupName] : []))].sort((a, b) => a.localeCompare(b)), [layers]);
  const filteredLayers = useMemo(() => layers.filter((layer) => layer.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())), [layers, search]);
  const orderedLayers = useMemo(() => layers.filter((layer) => layer.managed && layer.state === "READY" && layer.style), [layers]);
  const catalogPositions = useMemo(() => new Map(layers.map((layer, index) => [layer.id, index + 1])), [layers]);

  const refresh = useCallback(async () => {
    if (refreshing.current || mutation.current) return;
    refreshing.current = true;
    const revision = catalogRevision.current;
    try {
      const catalog = await gisRequest<Catalog>("/api/admin/layers");
      if (mounted.current && !mutation.current && revision === catalogRevision.current) {
        setLayers(catalog.layers); token.current = catalog.csrfToken;
        // Apply the map's metadata link once; polling must not reopen a canceled form.
        if (!initialHashHandled.current) {
          initialHashHandled.current = true;
          const target = catalog.layers.find((layer) => `#layer-${layer.id}` === window.location.hash && layer.managed && layer.state === "READY");
          if (target) {
            setEditing((current) => current ?? target.id);
            requestAnimationFrame(() => {
              if (mounted.current) document.getElementById(`layer-${target.id}`)?.scrollIntoView({ block: "center", inline: "nearest" });
            });
          }
        }
      }
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
    if (busyId || mutation.current) return;
    mutation.current = true; catalogRevision.current++;
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
    } finally { mutation.current = false; if (mounted.current) setBusyId(null); }
  }

  async function saveSettings(layer: AdminLayer, changes: { groupName?: string | null; defaultVisible?: boolean }) {
    if (busyId || mutation.current) return;
    mutation.current = true; catalogRevision.current++;
    setBusyId(layer.id); setNotice(null);
    try {
      const csrfToken = await csrf();
      const result = await gisRequest<{ layer: AdminLayer }>(`/api/admin/layers/${layer.id}/settings`, {
        method: "PATCH", headers: { "content-type": "application/json", "x-gis-csrf": csrfToken },
        body: JSON.stringify({ groupName: layer.groupName, defaultVisible: layer.defaultVisible, ...changes }),
      });
      if (!mounted.current) return;
      setLayers((previous) => previous.map((item) => item.id === layer.id ? result.layer : item));
      setEditingGroup(null);
      setNotice({ message: "Layer settings saved. Default visibility applies to new views; each viewer can keep their own visibility choices." });
    } catch (error) {
      if (mounted.current) setNotice({ error: true, message: error instanceof Error ? error.message : "The settings could not be saved." });
    } finally { mutation.current = false; if (mounted.current) setBusyId(null); }
  }

  async function moveLayer(layer: AdminLayer, direction: "up" | "down") {
    if (busyId || mutation.current) return;
    mutation.current = true; catalogRevision.current++;
    setBusyId(layer.id); setNotice(null);
    try {
      const csrfToken = await csrf();
      const result = await gisRequest<{ layers: AdminLayer[] }>("/api/admin/layers/order", {
        method: "POST", headers: { "content-type": "application/json", "x-gis-csrf": csrfToken },
        body: JSON.stringify({ layerId: layer.id, direction }),
      });
      if (!mounted.current) return;
      setLayers(result.layers);
      setNotice({ message: "Layer order saved. Layers higher in the list are drawn above those below them." });
    } catch (error) {
      if (mounted.current) setNotice({ error: true, message: error instanceof Error ? error.message : "The order could not be changed." });
    } finally { mutation.current = false; if (mounted.current) setBusyId(null); }
  }

  async function renameGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyId || mutation.current) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const from = String(data.get("from") ?? "").trim(), to = String(data.get("to") ?? "").trim();
    if (!from || !to || from === to) { setNotice({ error: true, message: "Choose a group and enter a different group name." }); return; }
    mutation.current = true; catalogRevision.current++;
    setBusyId("group-rename"); setNotice(null);
    try {
      const csrfToken = await csrf();
      const result = await gisRequest<{ layers: AdminLayer[] }>("/api/admin/layers/groups", {
        method: "PATCH", headers: { "content-type": "application/json", "x-gis-csrf": csrfToken }, body: JSON.stringify({ from, to }),
      });
      if (!mounted.current) return;
      setLayers(result.layers); form.reset(); setEditingGroup(null);
      setNotice({ message: `Group renamed to “${to}”. Layers using that group have been updated.` });
    } catch (error) {
      if (mounted.current) setNotice({ error: true, message: error instanceof Error ? error.message : "The group could not be renamed." });
    } finally { mutation.current = false; if (mounted.current) setBusyId(null); }
  }

  async function deleteLayer(layer: AdminLayer) {
    if (busyId || mutation.current || !window.confirm(`Delete “${layer.name}”? This permanently removes the layer and its associated GIS data. This cannot be undone.`)) return;
    mutation.current = true; catalogRevision.current++;
    setBusyId(layer.id); setNotice(null); setCanCheckAgain(false);
    try {
      const csrfToken = await csrf();
      const result = await gisRequest<{ jobId: string; layerId: string }>(`/api/admin/layers/${layer.id}`, {
        method: "DELETE", headers: { "x-gis-csrf": csrfToken },
      });
      if (!mounted.current) return;
      setLayers((previous) => previous.map((item) => item.id === layer.id ? { ...item, state: "DELETING" } : item));
      setEditing(null); setEditingGroup(null); setDeletion(result);
      setNotice({ message: "Deleting the layer and its associated GIS data…" });
    } catch (error) {
      if (mounted.current) { setBusyId(null); setNotice({ error: true, message: error instanceof Error ? error.message : "The layer could not be deleted. Please try again." }); }
    } finally { mutation.current = false; }
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
      {layers.length > 0 && <>
        <div className={styles.toolbar}>
          <label>Search admin layers<input type="search" value={search} placeholder="Search by layer name" onChange={(event) => setSearch(event.currentTarget.value)} /></label>
          {groups.length > 0 && <form onSubmit={(event) => void renameGroup(event)}>
            <label>Rename group<select name="from" defaultValue="" required disabled={Boolean(busyId)}><option value="" disabled>Select a group</option>{groups.map((group) => <option key={group} value={group}>{group}</option>)}</select></label>
            <label>New group name<input name="to" required maxLength={100} disabled={Boolean(busyId)} placeholder="Enter group name" /></label>
            <button type="submit" className="button button-quiet" disabled={Boolean(busyId)}>Rename group</button>
          </form>}
        </div>
        <p className={styles.summary}>{filteredLayers.length} of {layers.length} layers shown. The first layer is drawn on top. Publication controls access; default visibility sets the initial map checkbox.</p>
        <datalist id="existing-layer-groups">{groups.map((group) => <option key={group} value={group} />)}</datalist>
      </>}
      {notice && <div className={`notice gis-admin-notice ${notice.error ? "notice-error" : "notice-success"}`} role={notice.error ? "alert" : "status"}>
        <p>{notice.message}</p>
        {canCheckAgain && deletion && <button type="button" className="button button-quiet" onClick={() => { setBusyId(deletion.layerId); setCanCheckAgain(false); setMonitor((value) => value + 1); }}>Check deletion status</button>}
      </div>}
      {layers.length === 0 ? <div className="approval-empty"><h3>No GIS layers available.</h3><p className="muted">Upload a shapefile to add your first layer to the map.</p><Link href="/admin/upload" className="button button-primary">Upload shapefile</Link></div> : filteredLayers.length === 0 ? <p className={styles.emptySearch}>No layers match “{search}”. Clear the search to see all layers.</p> : <div className="gis-admin-table-scroll" tabIndex={0} role="region" aria-label="Layer management table"><table className="gis-admin-table">
        <caption className="approval-sr-only">GIS layers, publication status and management actions</caption>
        <thead><tr><th scope="col">Layer</th><th scope="col">Geometry</th><th scope="col">Group</th><th scope="col">Features</th><th scope="col">Visibility</th><th scope="col">Style type</th><th scope="col">Sort order</th><th scope="col">Status</th><th scope="col">Updated at</th><th scope="col">Actions</th></tr></thead>
        <tbody>{filteredLayers.map((layer) => <tr key={layer.id} id={`layer-${layer.id}`} className={styles.layerRow} data-layer-id={layer.id}>
          <td className="gis-admin-layer-name"><strong>{layer.name}</strong><p>{layer.description || "No description"}</p><small>{layer.layerType} · {layer.sourceType}</small>
            {editing === layer.id && <form onSubmit={(event) => save(event, layer)} className="gis-layer-edit"><label>Layer name<input name="name" defaultValue={layer.name} required maxLength={200} disabled={Boolean(busyId)} /></label><label>Description<textarea name="description" defaultValue={layer.description ?? ""} maxLength={2000} rows={3} disabled={Boolean(busyId)} /></label><div className="gis-admin-actions"><button className="button button-primary" type="submit" disabled={Boolean(busyId)}>{busyId === layer.id ? "Saving…" : "Save changes"}</button><button className="button button-quiet" type="button" disabled={Boolean(busyId)} onClick={() => setEditing(null)}>Cancel</button></div></form>}
          </td>
          <td>{layer.geometryType ?? "—"}<small>{layer.srid ? `EPSG:${layer.srid}` : "CRS unavailable"}</small></td>
          <td>{layer.groupName ?? "Ungrouped"}{editingGroup === layer.id && <form className={styles.settings} onSubmit={(event) => { event.preventDefault(); const groupName = String(new FormData(event.currentTarget).get("groupName") ?? "").trim(); void saveSettings(layer, { groupName: groupName || null }); }}>
            <label>Layer group<input name="groupName" list="existing-layer-groups" defaultValue={layer.groupName ?? ""} maxLength={100} disabled={Boolean(busyId)} placeholder="Choose or enter a group" /></label>
            <span className="muted">Leave blank to remove this layer from its group.</span>
            <div className="gis-admin-actions"><button className="button button-primary" type="submit" disabled={Boolean(busyId)}>Save group</button><button className="button button-quiet" type="button" disabled={Boolean(busyId)} onClick={() => setEditingGroup(null)}>Cancel group change</button></div>
          </form>}</td>
          <td>{layer.featureCount?.toLocaleString("en-GB") ?? "—"}</td>
          <td><div className={styles.visibility}><label className="gis-admin-checkbox"><input type="checkbox" checked={layer.isVisible} disabled={Boolean(busyId) || layer.state !== "READY" || !layer.managed} onChange={(event) => void updateLayer(layer, { isVisible: event.currentTarget.checked })} aria-label={`Visible to viewers: ${layer.name}`} />{layer.isVisible ? "Published" : "Unpublished"}</label><label className="gis-admin-checkbox"><input type="checkbox" checked={layer.defaultVisible} disabled={Boolean(busyId) || layer.state !== "READY" || !layer.managed || !layer.style} onChange={(event) => void saveSettings(layer, { defaultVisible: event.currentTarget.checked })} aria-label={`Visible by default: ${layer.name}`} />{layer.defaultVisible ? "On by default" : "Off by default"}</label></div></td>
          <td className={styles.mode}>{layer.style ? layer.style.mode === "categorized" ? "Categorized" : "Single Symbol" : "—"}{layer.style?.label.enabled && <small>Labels enabled</small>}</td>
          <td><div className={styles.order}><strong>{catalogPositions.get(layer.id)}</strong><button type="button" className="button button-quiet" aria-label={`Move up: ${layer.name}`} disabled={Boolean(busyId) || orderedLayers.findIndex((item) => item.id === layer.id) <= 0} onClick={() => void moveLayer(layer, "up")}>↑ Up</button><button type="button" className="button button-quiet" aria-label={`Move down: ${layer.name}`} disabled={Boolean(busyId) || !orderedLayers.some((item) => item.id === layer.id) || orderedLayers.at(-1)?.id === layer.id} onClick={() => void moveLayer(layer, "down")}>↓ Down</button></div></td>
          <td><span className={`status-badge gis-state-${layer.state.toLowerCase()}`}>{layer.state}</span></td>
          <td><time dateTime={layer.updatedAt}>{dates.format(new Date(layer.updatedAt))} WIB</time><small>Uploaded {dates.format(new Date(layer.createdAt))} WIB<br />{layer.uploadedBy ? `${layer.uploadedBy.name || "Administrator"} (${layer.uploadedBy.email})` : "—"}</small></td>
          <td><div className="gis-admin-actions gis-layer-actions">
            {layer.state === "READY" && <Link className="button button-quiet" href={`/map?layer=${layer.id}`}>View on map</Link>}
            {layer.state === "READY" && layer.managed && layer.style && <Link className="button button-quiet" href={`/admin/layers/${layer.id}/style`}>Edit Style</Link>}
            <button className="button button-quiet" type="button" disabled={Boolean(busyId) || layer.state !== "READY" || !layer.managed} onClick={() => setEditing(editing === layer.id ? null : layer.id)}>Edit details</button>
            <button className="button button-quiet" type="button" disabled={Boolean(busyId) || layer.state !== "READY" || !layer.managed || !layer.style} onClick={() => setEditingGroup(editingGroup === layer.id ? null : layer.id)}>Change group</button>
            <button className="button button-danger" type="button" disabled={Boolean(busyId) || !layer.managed || !["READY", "FAILED", "DELETING"].includes(layer.state)} onClick={() => void deleteLayer(layer)}>{busyId === layer.id && deletion ? "Deleting…" : layer.state === "DELETING" ? "Check / retry delete" : "Delete"}</button>
          </div>{!layer.managed && <small className="muted">Managed outside this portal</small>}</td>
        </tr>)}</tbody>
      </table></div>}
    </section>
  );
}
