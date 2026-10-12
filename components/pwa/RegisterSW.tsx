"use client";

// Starts BusyBee's service worker (public/sw.js) on every page and listens to
// it: a tapped notification opens its task here, and a new pop-up refreshes
// the bell straight away.

import { useEffect } from "react";
import { OPEN_TASK_EVENT, PUSH_EVENT } from "@/lib/appEvents";
import { syncPush } from "@/lib/pushClient";

const LOADED_AT = typeof performance !== "undefined" ? performance.timeOrigin : Date.now();

/** Something is being typed (a half-written task or message must not be lost). */
function busyTyping(): boolean {
  const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  if (el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !["button", "checkbox", "radio", "submit"].includes(el.type)))) return true;
  return Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input[type=text], input:not([type]), textarea")).some(
    (x) => x.value.trim().length > 0 && x.type !== "search"
  );
}

/**
 * A new release is out (the service worker saw it): reload onto it now if
 * nothing is being typed; otherwise as soon as the app is next put away and
 * brought back, with a small "Updated - tap to reload" bar meanwhile.
 */
let pendingReload = false;
function newRelease(latest: string) {
  if (pendingReload) return;
  // Already reloaded once for this release and still on the old one (the new
  // files haven't reached this phone's network yet): don't loop - try again
  // on the next open.
  try {
    if (sessionStorage.getItem("bb-reloaded-for") === latest) return;
    sessionStorage.setItem("bb-reloaded-for", latest);
  } catch {
    /* no storage: reload at most once per page anyway */
  }
  if (!busyTyping()) {
    window.location.reload();
    return;
  }
  pendingReload = true;
  const bar = document.createElement("button");
  bar.type = "button";
  bar.textContent = "BusyBee was updated - tap to reload";
  bar.setAttribute("data-bb-update", "");
  bar.style.cssText =
    "position:fixed;left:50%;transform:translateX(-50%);top:calc(env(safe-area-inset-top) + 64px);z-index:70;padding:8px 14px;border-radius:999px;background:#2563eb;color:#fff;font-size:13px;font-weight:600;border:0;box-shadow:0 4px 14px rgba(0,0,0,.35)";
  bar.onclick = () => window.location.reload();
  document.body.appendChild(bar);
  const onHide = () => {
    if (document.visibilityState === "hidden") window.location.reload();
  };
  document.addEventListener("visibilitychange", onHide);
}

/** Ask the service worker whether a newer release than this one is out. */
function checkRelease() {
  const release = process.env.NEXT_PUBLIC_RELEASE;
  if (!release) return;
  navigator.serviceWorker?.controller?.postMessage({ type: "bb-check-release", path: window.location.pathname, release });
}

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
      else if (d.type === "bb-new-release" && typeof d.release === "string") newRelease(d.release);
    };
    // Coming back to the app after a while: is there a new release?
    let hiddenAt = 0;
    const onVisible = () => {
      if (document.visibilityState === "hidden") hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > 30_000) checkRelease();
    };
    document.addEventListener("visibilitychange", onVisible);
    // And once just after opening: it may have opened from a saved copy of an
    // older release.
    const firstCheck = window.setTimeout(checkRelease, Math.max(0, 1500 - (Date.now() - LOADED_AT)));
    sw.addEventListener("message", onMessage);
    sw.startMessages?.();
    return () => {
      window.removeEventListener("load", register);
      sw.removeEventListener("message", onMessage);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearTimeout(firstCheck);
    };
  }, []);
  return null;
}
