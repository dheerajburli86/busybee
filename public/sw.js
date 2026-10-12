/* BusyBee service worker.
 *
 * Makes BusyBee installable as an app on phones, tablets and computers, opens
 * it fast, shows a friendly page instead of the browser's error when there is
 * no signal, and shows pop-up notifications even when the app is closed.
 *
 *   pages          the copy saved last time, at once (pages are empty
 *                  shells - the data comes separately), while the network
 *                  copy is fetched behind it for next time; a copy older
 *                  than a week waits for the network first. No copy and no
 *                  network: the offline page
 *   /_next/static  build files (their names change every release): cached
 *   /api           never cached here
 */
// Change VERSION whenever the cached files below change (icons, offline page);
// old caches are deleted when the new worker takes over.
const VERSION = "bb-2026-10-12b";
const SHELL = VERSION + "-shell";
const STATIC = VERSION + "-static";
const PAGES = VERSION + "-pages";
// How long a page may take from the network before an old saved copy is shown.
const SLOW_MS = 2500;
// Saved pages younger than this open straight away, without waiting for the
// network at all.
const INSTANT_MS = 7 * 24 * 3600 * 1000;
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

// Which release a page belongs to: its <meta name="bb-release"> (set at
// build time), or else the build files it loads.
function releaseOf(html) {
  const meta = /<meta name="bb-release" content="([^"]*)"/.exec(html || "");
  if (meta && meta[1]) return meta[1];
  const files = (html || "").match(/\/_next\/static\/[^"'\s)]+\.js/g) || [];
  return Array.from(new Set(files)).sort().join(" ");
}

// Save a page that came from the network. Returns true when it belongs to a
// newer release than the copy saved before (the old release's other saved
// pages are then dropped: each is fetched fresh the next time it's opened).
async function savePage(pages, key, copy, before) {
  const text = await copy.text();
  const newer = before !== null && before !== undefined && releaseOf(before) !== releaseOf(text);
  if (newer) {
    const keys = await pages.keys();
    await Promise.all(keys.filter((k) => k.url !== key).map((k) => pages.delete(k)));
  }
  const headers = new Headers(copy.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.set("x-bb-saved", String(Date.now()));
  await pages.put(key, new Response(text, { status: 200, headers }));
  return newer;
}

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
        const pages = await caches.open(PAGES);
        const key = url.origin + url.pathname;
        const saved = await pages.match(key);
        const savedText = saved ? saved.clone().text().catch(() => null) : Promise.resolve(null);
        const fetched = (async () => {
          const preloaded = await event.preloadResponse;
          const res = preloaded || (await fetch(req));
          // Real pages only - not sign-in redirects or errors.
          const ok = res.ok && res.type === "basic" && !res.redirected && (res.headers.get("content-type") || "").includes("text/html");
          return { res, copy: ok ? res.clone() : null };
        })();
        const network = fetched.then((f) => f.res);
        // Saved for next time, behind whatever is shown now. (If it is a new
        // release, the app finds out when it asks - see "bb-check-release".)
        event.waitUntil(
          fetched
            .then(async ({ copy }) => {
              if (copy) await savePage(pages, key, copy, await savedText);
            })
            .catch(() => {})
        );
        const offline = async () =>
          (await caches.match("/offline.html")) || new Response("You're offline.", { status: 503, headers: { "Content-Type": "text/plain" } });
        // Opened recently: the saved copy at once, no waiting on the network.
        // (A reload asks the network first.)
        const age = saved ? Date.now() - Number(saved.headers.get("x-bb-saved") || 0) : Infinity;
        if (saved && age < INSTANT_MS && req.cache !== "reload" && req.cache !== "no-cache") {
          network.catch(() => {});
          return saved;
        }
        if (!saved) {
          try {
            return await network;
          } catch (e) {
            return offline();
          }
        }
        // A saved copy exists: the network gets a moment, then the copy is
        // shown and the network answer still updates it for next time.
        try {
          const winner = await Promise.race([network, new Promise((r) => setTimeout(() => r(null), SLOW_MS))]);
          if (winner) return winner;
          event.waitUntil(network.catch(() => {}));
          return saved;
        } catch (e) {
          return saved;
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

// ---- New releases ------------------------------------------------------------
// The app says which release it is running when it opens and whenever it comes
// back to the screen (components/pwa/RegisterSW). The page is fetched fresh;
// if it belongs to another release, the app is told to reload onto it.
self.addEventListener("message", (event) => {
  const d = event.data || {};
  if (d.type !== "bb-check-release" || typeof d.path !== "string" || !d.path.startsWith("/") || !d.release) return;
  const source = event.source;
  event.waitUntil(
    (async () => {
      const res = await fetch(d.path, { cache: "no-store", credentials: "same-origin", headers: { Accept: "text/html" } });
      const ok = res.ok && res.type === "basic" && !res.redirected && (res.headers.get("content-type") || "").includes("text/html");
      if (!ok) return;
      const text = await res.clone().text();
      const pages = await caches.open(PAGES);
      const key = self.location.origin + d.path;
      // Keep a saved copy current (so a reload opens the new release), but
      // don't start saving pages that were never saved.
      const saved = await pages.match(key);
      if (saved) await savePage(pages, key, res, await saved.text());
      const latest = releaseOf(text);
      if (latest && latest !== d.release && source) source.postMessage({ type: "bb-new-release", release: latest });
    })().catch(() => {})
  );
});
