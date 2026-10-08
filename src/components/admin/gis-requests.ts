"use client";

export type ProcessingJob = {
  id: string;
  kind: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  layerId: string;
  error: { code: string; message: string } | null;
};

export function apiMessage(value: unknown, fallback: string): string {
  if (value && typeof value === "object" && "message" in value &&
      typeof value.message === "string") return value.message.slice(0, 350);
  return fallback;
}

export function checkAccess(status: number) {
  if (status === 401 || status === 403) {
    window.location.replace("/admin");
    throw new Error("Your access could not be verified. Returning to Administration…");
  }
}

export async function gisRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    ...init,
    signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
  });
  checkAccess(response.status);
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(apiMessage(body, "The request could not be completed. Please try again."));
  return body as T;
}

export async function pollGisJob(
  jobId: string,
  signal: AbortSignal,
  onStatus: (job: ProcessingJob) => void,
): Promise<ProcessingJob> {
  for (let attempt = 0; attempt < 200; attempt++) {
    signal.throwIfAborted();
    const job = await gisRequest<ProcessingJob>(`/api/admin/jobs/${encodeURIComponent(jobId)}`, { signal });
    onStatus(job);
    if (job.status === "SUCCEEDED" || job.status === "FAILED") return job;
    await new Promise<void>((resolve, reject) => {
      const aborted = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, 3000);
      signal.addEventListener("abort", aborted, { once: true });
    });
  }
  throw new Error("Processing is taking longer than expected. Check its status again or view the Layers page.");
}
