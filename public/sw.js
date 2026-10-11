/* BusyBee service worker.
 *
 * Makes BusyBee installable as an app on phones, tablets and computers, opens
 * it fast, shows a friendly page instead of the browser's error when there is
 * no signal, and shows pop-up notifications even when the app is closed.
 *
 *   pages          always fresh from the network; the offline page if there's none
 *   /_next/static  build files (their names change every release): cached
 *   /api           never cached
 */
// Change VERSION whenever the cached files below change (icons, offline page);
// old caches are deleted when the new worker takes over.
const VERSION = "bb-2026-10-11";
const SHELL = VERSION + "-shell";
const STATIC = VERSION + "-static";
const SHELL_FILES = ["/offline.html", "/icons/icon-192.png", "/icons/badge-96.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(SHELL_FILES))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith("bb-") && !n.startsWith(VERSION)).map((n) => caches.delete(n)));
      if (self.registration.navigationPreload) {
        try {
          await self.registration.navigationPreload.enable();
        } catch (e) {
          /* not supported here */
        }
      }
      await self.clients.claim();
    })()
  );
});

async function trim(cache, max) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const preloaded = await event.preloadResponse;
          if (preloaded) return preloaded;
          return await fetch(req);
        } catch (e) {
          const offline = await caches.match("/offline.html");
          return offline || new Response("You're offline.", { status: 503, headers: { "Content-Type": "text/plain" } });
        }
      })()
    );
    return;
  }

  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(STATIC);
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok && res.type === "basic") {
          cache.put(req, res.clone()).then(() => trim(cache, 250)).catch(() => {});
        }
        return res;
      })()
    );
  }
});

// ---- Pop-up notifications ------------------------------------------------

self.addEventListener("push", (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch (e) {
    d = { body: event.data ? event.data.text() : "" };
  }
  const title = d.title || "BusyBee";
  const options = {
    body: d.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-96.png",
    data: { url: d.url || "/dashboard" },
    timestamp: d.ts || Date.now(),
    vibrate: [90, 40, 90],
  };
  if (d.tag) {
    // A newer alert about the same task or chat replaces the older one, and
    // still buzzes.
    options.tag = d.tag;
    options.renotify = true;
  }
  event.waitUntil(
    (async () => {
      // Always show something: phones stop delivering to apps that receive a
      // push without showing a notification.
      await self.registration.showNotification(title, options);
      if (typeof d.badge === "number" && self.navigator && "setAppBadge" in self.navigator) {
        try {
          if (d.badge > 0) await self.navigator.setAppBadge(d.badge);
          else await self.navigator.clearAppBadge();
        } catch (e) {
          /* badges not allowed here */
        }
      }
      // An open BusyBee refreshes its bell straight away.
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      wins.forEach((w) => w.postMessage({ type: "bb-push", payload: d }));
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/dashboard", self.location.origin);
  const url = target.origin === self.location.origin ? target.href : self.location.origin + "/dashboard";
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = wins.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        // BusyBee is already open: bring it forward and go to the task there.
        try {
          await open.focus();
        } catch (e) {
          /* focus needs the tap; carry on */
        }
        open.postMessage({ type: "bb-open", url });
        return;
      }
      if (self.clients.openWindow) await self.clients.openWindow(url);
    })()
  );
});

// The phone renewed its subscription on its own: tell the server the new one.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const old = event.oldSubscription;
      let sub = event.newSubscription;
      if (!sub) {
        let key = old && old.options && old.options.applicationServerKey;
        if (!key) {
          const r = await fetch("/api/push/key", { credentials: "same-origin" });
          if (!r.ok) return;
          const b64 = (await r.json()).publicKey;
          const s = (b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
          key = Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
        }
        sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      }
      await fetch("/api/push/subscribe", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON(), old_endpoint: old ? old.endpoint : null }),
      });
    })().catch(() => {})
  );
});
