"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { apiMessage, checkAccess, gisRequest, pollGisJob } from "./gis-requests";

type Phase = "idle" | "uploading" | "processing" | "succeeded" | "failed";

export function ShapefileUpload({ maxUploadBytes }: { maxUploadBytes: number }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const [name, setName] = useState("");
  const [job, setJob] = useState<{ jobId: string; layerId: string } | null>(null);
  const [monitor, setMonitor] = useState(0);
  const [canCheckAgain, setCanCheckAgain] = useState(false);
  const upload = useRef<XMLHttpRequest | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const mounted = useRef(true);
  const busy = phase === "uploading" || phase === "processing";
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; upload.current?.abort(); };
  }, []);

  useEffect(() => {
    if (!job) return;
    const controller = new AbortController();
    async function monitorJob() {
      try {
        const result = await pollGisJob(job!.jobId, controller.signal, (current) => {
          if (!controller.signal.aborted) setMessage(current.status === "QUEUED"
            ? "Your upload is queued. It will appear on the map after processing."
            : "Preparing your layer. This may take a few minutes.");
        });
        if (controller.signal.aborted) return;
        setCanCheckAgain(false);
        if (result.status === "FAILED") {
          setPhase("failed");
          setMessage(`${apiMessage(result.error, "The shapefile could not be processed.")} Delete this failed layer in Layers before uploading a corrected ZIP with the same name.`);
        } else {
          setPhase("succeeded");
          setMessage("Your layer is ready. You can view it on the map or manage its details.");
        }
      } catch {
        if (!controller.signal.aborted) {
          setPhase("failed");
          setCanCheckAgain(true);
          setMessage("We could not confirm the processing status. Your upload may still be processing. Check its status before uploading it again.");
        }
      }
    }
    void monitorJob();
    return () => controller.abort();
  }, [job, monitor]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    const file = data.get("file");
    if (!(file instanceof File) || !file.size || !file.name.toLowerCase().endsWith(".zip")) {
      setPhase("failed"); setMessage("Choose a ZIP file containing one complete shapefile dataset."); return;
    }
    if (file.size > maxUploadBytes) {
      setPhase("failed"); setMessage(`The ZIP file must be smaller than ${(maxUploadBytes / 1024 / 1024).toFixed(0)} MB.`); return;
    }
    if (!name.trim()) {
      setPhase("failed"); setMessage("Enter a name for this layer."); return;
    }
    data.set("name", name.trim());
    data.set("isVisible", data.get("isVisible") === "on" ? "true" : "false");
    setJob(null); setCanCheckAgain(false); setProgress(0); setPhase("uploading"); setMessage("Uploading your ZIP file…");
    try {
      const config = await gisRequest<{ csrfToken: string }>("/api/admin/uploads");
      if (!mounted.current) return;
      const accepted = await new Promise<{ jobId: string; layerId: string }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        upload.current = xhr;
        xhr.open("POST", "/api/admin/uploads");
        xhr.setRequestHeader("x-gis-csrf", config.csrfToken);
        xhr.timeout = 180000;
        xhr.upload.onprogress = (progressEvent) => {
          if (mounted.current && progressEvent.lengthComputable) setProgress(Math.round(progressEvent.loaded / progressEvent.total * 100));
        };
        xhr.onload = () => {
          try {
            checkAccess(xhr.status);
            const body = JSON.parse(xhr.responseText);
            if (xhr.status < 200 || xhr.status >= 300) throw new Error(apiMessage(body, "The upload could not be accepted. Please try again."));
            if (typeof body.jobId !== "string" || typeof body.layerId !== "string") throw new Error("The upload response could not be confirmed. Check the Layers page before uploading again.");
            resolve(body);
          } catch (error) { reject(error); }
        };
        xhr.onerror = () => reject(new Error("The upload connection was interrupted. Check the Layers page before uploading again."));
        xhr.ontimeout = () => reject(new Error("The upload timed out. Check the Layers page before uploading again."));
        xhr.onabort = () => reject(new Error("The upload was interrupted."));
        xhr.send(data);
      });
      if (mounted.current) { setPhase("processing"); setMessage("Your upload is queued for processing."); setJob(accepted); }
    } catch (error) {
      if (mounted.current) { setPhase("failed"); setMessage(error instanceof Error ? error.message : "The upload could not be completed. Please try again."); }
    } finally { upload.current = null; }
  }

  return (
    <section className="gis-admin-panel gis-upload-panel" aria-label="Shapefile upload">
      <div className="gis-upload-instructions">
        <h2>One ZIP, one layer</h2>
        <p>Include matching <strong>.shp, .shx, .dbf and .prj</strong> files. An optional .cpg file preserves text encoding.</p>
        <p className="muted">Maximum ZIP size: {(maxUploadBytes / 1024 / 1024).toFixed(0)} MB. Points, lines and polygons are supported. Raster files are not supported.</p>
      </div>
      {message && <div className={`notice ${phase === "failed" ? "notice-error" : phase === "succeeded" ? "notice-success" : ""}`} role={phase === "failed" ? "alert" : "status"} aria-live="polite">
        <p>{message}</p>
        {phase === "uploading" && <div className="gis-upload-progress"><progress max={100} value={progress} aria-label="Upload progress" /><span>{progress}% uploaded</span></div>}
        {phase === "processing" && <p className="gis-processing-label"><span className="gis-processing-dot" aria-hidden="true" />Processing your layer…</p>}
        {canCheckAgain && <button type="button" className="button button-quiet" onClick={() => { setPhase("processing"); setMonitor((value) => value + 1); }}>Check processing status</button>}
        {phase === "succeeded" && job && <div className="gis-admin-actions"><Link className="button button-primary" href={`/map?layer=${job.layerId}`}>View on map</Link><Link className="button button-quiet" href="/admin/layers">Manage layers</Link></div>}
      </div>}
      {phase !== "succeeded" ? <form ref={form} onSubmit={submit} className="gis-upload-form">
        <fieldset disabled={busy}>
          <label>Shapefile ZIP<input name="file" type="file" accept=".zip,application/zip" required onChange={(event) => { const selected = event.currentTarget.files?.[0]; if (selected && !name) setName(selected.name.replace(/\.zip$/i, "").slice(0, 200)); }} /></label>
          <label>Layer name<input name="name" type="text" value={name} onChange={(event) => setName(event.currentTarget.value)} maxLength={200} required placeholder="For example: Office locations" /></label>
          <label>Description <span className="muted">(optional)</span><textarea name="description" maxLength={2000} rows={4} placeholder="Describe the information in this layer." /></label>
          <label className="gis-admin-checkbox"><input type="checkbox" name="isVisible" defaultChecked />Visible to approved viewers</label>
          <p className="muted">Hidden layers are available to administrators for review.</p>
          <div className="gis-admin-actions"><button className="button button-primary" type="submit">{busy ? phase === "uploading" ? "Uploading…" : "Processing…" : "Upload shapefile"}</button><Link href="/admin/layers" className="button button-quiet">Back to layers</Link></div>
        </fieldset>
      </form> : <button type="button" className="button button-quiet" onClick={() => { setPhase("idle"); setMessage(""); setJob(null); setName(""); }}>Upload another layer</button>}
    </section>
  );
}
