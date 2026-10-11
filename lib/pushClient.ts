// The browser side of BusyBee as an app: is it installed, which device is
// this, and turning pop-up notifications on and off for this device.
//
// iPhone and iPad only allow pop-ups inside the installed app (added to the
// Home Screen), on iOS / iPadOS 16.4 or newer. Android and computers allow
// them in the browser too.

export type Platform = "ios" | "android" | "desktop";
export type PushState = "unsupported" | "needs-install" | "blocked" | "off" | "on";

const ENDPOINT_KEY = "bb-push-endpoint";
const SYNCED_KEY = "bb-push-synced";

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const mq = (q: string) => window.matchMedia?.(q).matches;
  return !!(mq("(display-mode: standalone)") || mq("(display-mode: fullscreen)") || (navigator as any).standalone === true);
}

export function isIpad(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  // iPadOS asks for desktop sites, so it says "Macintosh" - but has a touch screen.
  return /iPad/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
}

export function platform(): Platform {
  if (typeof navigator === "undefined") return "desktop";
  const ua = navigator.userAgent || "";
  if (/iPhone|iPod/.test(ua) || isIpad()) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "desktop";
}

/** "iPhone", "Android phone", "Windows computer"... for the list of devices in Settings. */
export function deviceLabel(): string {
  const ua = navigator.userAgent || "";
  if (isIpad()) return "iPad";
  if (/iPhone|iPod/.test(ua)) return "iPhone";
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? "Android phone" : "Android tablet";
  if (/CrOS/.test(ua)) return "Chromebook";
  if (/Windows/.test(ua)) return "Windows computer";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Linux/.test(ua)) return "Linux computer";
  return "This device";
}

/** iOS version as a number (16.4), or null when it isn't iOS / can't tell. */
export function iosVersion(): number | null {
  if (platform() !== "ios") return null;
  const ua = navigator.userAgent || "";
  const m = ua.match(/OS (\d+)[_.](\d+)/) || ua.match(/Version\/(\d+)\.(\d+)/);
  return m ? Number(`${m[1]}.${m[2]}`) : null;
}

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext !== false &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

function storage(key: string, value?: string | null): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage blocked */
  }
  return null;
}

let keyCache: string | null = null;

/** The server's public key, which this device needs to subscribe. */
export async function serverKey(): Promise<string | null> {
  if (keyCache) return keyCache;
  try {
    const r = await fetch("/api/push/key", { cache: "no-store" });
    if (!r.ok) return null;
    const d = await r.json();
    keyCache = typeof d.publicKey === "string" ? d.publicKey : null;
  } catch {
    /* offline */
  }
  return keyCache;
}

function b64ToBytes(b64: string): Uint8Array {
  const s = (b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/** Was this subscription made with the server's current key? */
function sameKey(sub: PushSubscription, key: string): boolean {
  const have = sub.options?.applicationServerKey;
  if (!have) return true;
  const a = new Uint8Array(have);
  const b = b64ToBytes(key);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** The service worker, registering it if this page hasn't yet. */
async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  let reg = (await navigator.serviceWorker.getRegistration("/")) || null;
  if (!reg) {
    try {
      reg = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
    } catch {
      return null;
    }
  }
  if (reg.active) return reg;
  // Wait (briefly) for a brand-new worker to finish starting.
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<ServiceWorkerRegistration | null>((r) => setTimeout(() => r(null), 10000)),
  ]);
}

async function tellServer(sub: PushSubscription, oldEndpoint?: string | null): Promise<void> {
  const r = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: sub.toJSON(), device: deviceLabel(), old_endpoint: oldEndpoint || null }),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d?.error || "Couldn't save this device");
  }
  storage(ENDPOINT_KEY, sub.endpoint);
  storage(SYNCED_KEY, String(Date.now()));
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/");
    return (await reg?.pushManager.getSubscription()) || null;
  } catch {
    return null;
  }
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return platform() === "ios" && !isStandalone() ? "needs-install" : "unsupported";
  if (Notification.permission === "denied") return "blocked";
  if (Notification.permission !== "granted") return "off";
  return (await currentSubscription()) ? "on" : "off";
}

/**
 * Turn pop-ups on for this device. Call it straight from a tap: iPhones only
 * show the "Allow notifications?" question in response to one.
 */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) return platform() === "ios" && !isStandalone() ? "needs-install" : "unsupported";
  const keyLoad = serverKey(); // in parallel - the question must come first
  let permission = Notification.permission;
  if (permission === "default") permission = await Notification.requestPermission();
  if (permission === "denied") return "blocked";
  if (permission !== "granted") return "off";

  const key = await keyLoad;
  if (!key) throw new Error("Pop-up notifications aren't set up on the server yet.");
  const reg = await registration();
  if (!reg) throw new Error("This browser couldn't start BusyBee's background helper. Reload and try again.");
  let sub = await reg.pushManager.getSubscription();
  const old = storage(ENDPOINT_KEY);
  if (sub && !sameKey(sub, key)) {
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) as BufferSource });
  await tellServer(sub, old && old !== sub.endpoint ? old : null);
  return "on";
}

/** Turn pop-ups off for this device. */
export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (sub) {
    await fetch("/api/push/subscribe", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
  storage(ENDPOINT_KEY, null);
  storage(SYNCED_KEY, null);
}

/**
 * On app start: if pop-ups are on, make sure the server still has this
 * device (re-checked once a day, or straight away if the phone renewed it).
 */
export async function syncPush(): Promise<void> {
  if (!pushSupported() || Notification.permission !== "granted") return;
  const sub = await currentSubscription();
  if (!sub) return;
  const last = Number(storage(SYNCED_KEY)) || 0;
  const known = storage(ENDPOINT_KEY);
  if (known === sub.endpoint && Date.now() - last < 24 * 3600 * 1000) return;
  const key = await serverKey();
  if (key && !sameKey(sub, key)) {
    // The server has a new key pair: this subscription can't be used any more.
    // (Making a new one may need a tap on iPhone; the bar at the top offers it.)
    await sub.unsubscribe().catch(() => {});
    storage(ENDPOINT_KEY, null);
    return;
  }
  await tellServer(sub, known && known !== sub.endpoint ? known : null).catch(() => {});
}

/** Android/computers: the browser's own "Install app" offer, if it made one. */
export function installOffer(): any | null {
  return typeof window !== "undefined" ? (window as any).__bbInstall || null : null;
}

/** Show the browser's install question. Resolves true if they installed. */
export async function promptInstall(): Promise<boolean> {
  const offer = installOffer();
  if (!offer) return false;
  try {
    await offer.prompt();
    const choice = await offer.userChoice;
    (window as any).__bbInstall = null;
    return choice?.outcome === "accepted";
  } catch {
    return false;
  }
}
