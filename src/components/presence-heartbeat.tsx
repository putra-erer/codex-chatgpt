"use client";

import { useEffect } from "react";
import { HEARTBEAT_INTERVAL_MS } from "@/shared/presence";

export function PresenceHeartbeat() {
  useEffect(() => {
    let stopped = false;
    let forbidden = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    let segment: { tabId: string; inFlight: Promise<void> | null; left: boolean } | null = null;

    async function send(tabId: string, activity: "heartbeat" | "leave") {
      try {
        const response = await fetch("/api/presence", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          keepalive: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tabId, activity }),
          signal: AbortSignal.timeout(10_000),
        });
        if (response.status === 401 || response.status === 403) forbidden = true;
      } catch {
        // A disconnected browser expires on the server without a successful heartbeat.
      }
    }

    function heartbeat() {
      if (stopped || forbidden || document.visibilityState !== "visible" || !navigator.onLine) return;
      segment ??= { tabId: crypto.randomUUID(), inFlight: null, left: false };
      const active = segment;
      if (active.inFlight) return;
      active.inFlight = send(active.tabId, "heartbeat").finally(() => {
        active.inFlight = null;
      });
    }

    function leave() {
      if (interval) clearInterval(interval);
      interval = undefined;
      const previous = segment;
      segment = null;
      if (!previous || previous.left) return;
      previous.left = true;
      // Finish this segment's heartbeat before its leave request. Returning to the
      // page gets a new ID, so a delayed leave cannot remove the new active visit.
      if (previous.inFlight) {
        void previous.inFlight.then(() => send(previous.tabId, "leave"));
      } else {
        void send(previous.tabId, "leave");
      }
    }

    function resume() {
      if (stopped || document.visibilityState !== "visible") return;
      heartbeat();
      interval ??= setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
    }

    function visibilityChanged() {
      if (document.visibilityState === "visible") resume();
      else leave();
    }

    resume();
    document.addEventListener("visibilitychange", visibilityChanged);
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", resume);
    window.addEventListener("online", resume);
    window.addEventListener("offline", leave);
    return () => {
      stopped = true;
      leave();
      document.removeEventListener("visibilitychange", visibilityChanged);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener("offline", leave);
    };
  }, []);

  return null;
}
