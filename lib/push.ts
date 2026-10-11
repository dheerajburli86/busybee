// Pop-up notifications on people's phones, tablets and computers.
//
// Anyone who turns notifications on (Settings, or the bar at the top of the
// app) gets a device row in push_subscriptions. Alerts then pop up on every
// device they turned on - see lib/alerts.ts for who gets which alert.
//
// The key pair the browsers trust lives in app_secrets and is made here the
// first time anyone turns notifications on, so there is nothing to set up.
// VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in the environment override it.
// Needs SUPABASE_SERVICE_ROLE_KEY (already set for Telegram); without it
// pop-ups are skipped and everything else works as before.

import { adminConfigured, createAdminClient } from "@/lib/supabase-admin";
import { Device, PushPayload, Vapid, newVapidKeys, sendToDevices } from "@/lib/push-core";

const SUBJECT = (process.env.VAPID_SUBJECT || "").trim() || "mailto:gqbusybee@gmail.com";

let cached: { v: Vapid; at: number } | null = null;

function fromEnv(): Vapid | null {
  const publicKey = (process.env.VAPID_PUBLIC_KEY || "").trim();
  const privateKey = (process.env.VAPID_PRIVATE_KEY || "").trim();
  return publicKey && privateKey ? { publicKey, privateKey, subject: SUBJECT } : null;
}

export function pushConfigured(): boolean {
  return Boolean(fromEnv()) || adminConfigured();
}

/** The server's key pair. With `create`, made and saved if there isn't one yet. */
export async function vapidKeys(create = false): Promise<Vapid | null> {
  const env = fromEnv();
  if (env) return env;
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.v;
  const db = createAdminClient();
  if (!db) return null;

  const read = async (): Promise<Vapid | null> => {
    const { data, error } = await db.from("app_secrets").select("value").eq("key", "vapid").maybeSingle();
    if (error || !data) return null;
    try {
      const v = JSON.parse(data.value);
      return v?.publicKey && v?.privateKey ? { publicKey: v.publicKey, privateKey: v.privateKey, subject: v.subject || SUBJECT } : null;
    } catch {
      return null;
    }
  };

  let v = await read();
  if (!v && create) {
    const k = newVapidKeys();
    // If two servers get here at once, the first one's keys win and both
    // read the same pair back.
    await db
      .from("app_secrets")
      .upsert({ key: "vapid", value: JSON.stringify({ ...k, subject: SUBJECT }) }, { onConflict: "key", ignoreDuplicates: true });
    v = await read();
  }
  if (v) cached = { v, at: Date.now() };
  return v;
}

export type PushMessage = { title: string; body: string; url?: string; tag?: string };

/**
 * Pop up `message` on every device these people turned notifications on.
 * Pass a function to word it per person (return null to skip someone).
 * Never throws; devices that are gone for good are removed.
 */
export async function pushToUsers(
  userIds: string[],
  message: PushMessage | ((userId: string) => PushMessage | null),
  opts: { urgency?: "high" | "normal" | "low" } = {}
): Promise<{ sent: number; devices: number }> {
  const none = { sent: 0, devices: 0 };
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  if (!ids.length) return none;
  try {
    const db = createAdminClient();
    if (!db) return none;
    const { data: subs, error } = await db
      .from("push_subscriptions")
      .select("id, user_id, endpoint, p256dh, auth")
      .in("user_id", ids);
    if (error || !subs || subs.length === 0) return none;
    const vapid = await vapidKeys();
    if (!vapid) return none;

    // The number on the app icon: unread notifications, per person.
    const owners = Array.from(new Set(subs.map((s: any) => s.user_id as string)));
    const unread = new Map<string, number>();
    const { data: rows } = await db.from("notifications").select("user_id").in("user_id", owners).eq("read", false).limit(5000);
    (rows || []).forEach((r: any) => unread.set(r.user_id, (unread.get(r.user_id) || 0) + 1));

    const words = new Map<string, PushMessage | null>();
    owners.forEach((uid) => words.set(uid, typeof message === "function" ? message(uid) : message));

    const result = await sendToDevices(
      subs as Device[],
      (d): PushPayload | null => {
        const m = words.get(d.user_id || "");
        if (!m) return null;
        return { title: m.title, body: m.body, url: m.url || "/dashboard", tag: m.tag, badge: unread.get(d.user_id || "") || 0 };
      },
      vapid,
      opts
    );

    const now = new Date().toISOString();
    const jobs: PromiseLike<unknown>[] = [];
    if (result.gone.length) jobs.push(db.from("push_subscriptions").delete().in("id", result.gone));
    if (result.ok.length) jobs.push(db.from("push_subscriptions").update({ last_ok_at: now, last_error: null }).in("id", result.ok));
    for (const f of result.failed) {
      jobs.push(db.from("push_subscriptions").update({ last_error: f.error }).eq("id", f.id));
      console.error("pop-up notification failed:", f.error);
    }
    await Promise.allSettled(jobs);
    return { sent: result.ok.length, devices: subs.length };
  } catch (err) {
    console.error("pop-up notifications failed:", err);
    return none;
  }
}
