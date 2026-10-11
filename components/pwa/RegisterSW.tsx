"use client";

// Starts BusyBee's service worker (public/sw.js) on every page and listens to
// it: a tapped notification opens its task here, and a new pop-up refreshes
// the bell straight away.

import { useEffect } from "react";
import { OPEN_TASK_EVENT, PUSH_EVENT } from "@/lib/appEvents";
import { syncPush } from "@/lib/pushClient";

function openUrl(raw: string) {
  let u: URL;
  try {
    u = new URL(raw, window.location.origin);
  } catch {
    return;
  }
  if (u.origin !== window.location.origin) return;
  const task = u.searchParams.get("task");
  if (u.pathname === "/dashboard" && task && window.location.pathname === "/dashboard") {
    // Already on the task list: open the task without reloading the page.
    window.dispatchEvent(new CustomEvent(OPEN_TASK_EVENT, { detail: task }));
    return;
  }
  if (u.pathname + u.search === window.location.pathname + window.location.search) return;
  window.location.assign(u.pathname + u.search + u.hash);
}

export function RegisterSW() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const sw = navigator.serviceWorker;

    const register = () => {
      sw.register("/sw.js", { scope: "/", updateViaCache: "none" })
        .then(() => syncPush())
        .catch(() => {
          /* no service worker: BusyBee still works as a website */
        });
    };
    // After the page has painted, so it never slows the first screen.
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });

    const onMessage = (e: MessageEvent) => {
      const d = e.data || {};
      if (d.type === "bb-open" && typeof d.url === "string") openUrl(d.url);
      else if (d.type === "bb-push") window.dispatchEvent(new CustomEvent(PUSH_EVENT, { detail: d.payload }));
    };
    sw.addEventListener("message", onMessage);
    sw.startMessages?.();
    return () => {
      window.removeEventListener("load", register);
      sw.removeEventListener("message", onMessage);
    };
  }, []);
  return null;
}
