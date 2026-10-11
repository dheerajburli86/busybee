// Sending pop-up notifications (Web Push): encrypt the message for each
// device and hand it to that device's push service - Google for Android and
// Chrome, Apple for iPhone, iPad and Safari, Mozilla for Firefox, Microsoft
// for Edge. No database here (lib/push.ts adds that), so this file can be
// tested on its own.

import webpush from "web-push";

export type Vapid = { publicKey: string; privateKey: string; subject: string };
export type Device = { id: string; user_id?: string; endpoint: string; p256dh: string; auth: string };

/** What the service worker (public/sw.js) shows. */
export type PushPayload = {
  title: string;
  body: string;
  /** Page to open when the notification is tapped, e.g. /dashboard?task=... */
  url: string;
  /** Notifications with the same tag replace each other instead of piling up. */
  tag?: string;
  /** Number for the app icon badge (unread notifications). */
  badge?: number;
  ts?: number;
};

export type SendResult = {
  ok: string[];
  /** Devices that will never accept a message again: delete them. */
  gone: string[];
  failed: { id: string; error: string }[];
};

export function newVapidKeys(): { publicKey: string; privateKey: string } {
  return webpush.generateVAPIDKeys();
}

const clip = (s: unknown, n: number) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

export function cleanPayload(p: PushPayload): PushPayload {
  return {
    title: clip(p.title, 120) || "BusyBee",
    body: clip(p.body, 600),
    url: p.url && p.url.startsWith("/") ? p.url : "/dashboard",
    ...(p.tag ? { tag: clip(p.tag, 64) } : {}),
    ...(typeof p.badge === "number" ? { badge: Math.max(0, Math.floor(p.badge)) } : {}),
    ts: p.ts || Date.now(),
  };
}

/**
 * A device is gone for good when its push service says so (404/410), or when
 * it was subscribed with a different key pair. Problems with our own request
 * (a bad or expired token) are not the device's fault, so it stays.
 */
export function isGone(status: number | undefined, body: string): boolean {
  if (status === 404 || status === 410) return true;
  if (status === 400 || status === 401 || status === 403) {
    if (/jwt/i.test(body)) return false;
    return /mismatch|do(es)? not correspond|unsubscribed|expired subscription|invalid registration|NotRegistered/i.test(body);
  }
  return false;
}

export async function sendToDevices(
  devices: Device[],
  payload: PushPayload | ((d: Device) => PushPayload | null),
  vapid: Vapid,
  opts: { urgency?: "high" | "normal" | "low"; ttl?: number; timeoutMs?: number } = {}
): Promise<SendResult> {
  const result: SendResult = { ok: [], gone: [], failed: [] };
  await Promise.all(
    devices.map(async (d) => {
      const p = typeof payload === "function" ? payload(d) : payload;
      if (!p) return;
      try {
        await webpush.sendNotification(
          { endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } },
          JSON.stringify(cleanPayload(p)),
          {
            vapidDetails: vapid,
            // Kept for a day if the phone is off or out of signal.
            TTL: opts.ttl ?? 86400,
            urgency: opts.urgency ?? "high",
            timeout: opts.timeoutMs ?? 10000,
          }
        );
        result.ok.push(d.id);
      } catch (err: any) {
        const status: number | undefined = err?.statusCode;
        const body = String(err?.body || err?.message || err || "");
        if (isGone(status, body)) result.gone.push(d.id);
        else result.failed.push({ id: d.id, error: `${status ?? ""} ${body}`.trim().slice(0, 300) });
      }
    })
  );
  return result;
}
