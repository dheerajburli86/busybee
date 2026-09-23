// SOW #30 / #39: email alongside in-app notifications.
//
// This calls Resend's REST endpoint directly rather than pulling in an SDK, so
// nothing needs installing and the bundle is unchanged. To switch providers,
// replace the body of deliver() - everything else works off sendMail().
//
// Until RESEND_API_KEY is set the whole thing is a no-op: it logs and returns
// false. Nothing that calls sendMail treats that as an error, so the app keeps
// working normally with in-app notifications only.

import { createServerSideClient } from "@/lib/supabase-server";
import { getPrefsMap, wantsEmail } from "@/lib/notifications";

const FROM = process.env.MAIL_FROM || "BusyBee <onboarding@resend.dev>";

export function mailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** POST to Resend, retrying once if it says we're sending too fast. */
async function post(path: string, payload: unknown): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`https://api.resend.com${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) return true;
      if (res.status === 429 && attempt === 0) {
        await sleep(1100);
        continue;
      }
      // A failed email must never take down the request that triggered it.
      console.error("email send failed:", res.status, await res.text());
      return false;
    } catch (err) {
      console.error("email send threw:", err);
      return false;
    }
  }
  return false;
}

/**
 * One message per recipient, so nobody sees anyone else's address. Several
 * recipients go in a single batch request (up to 100 per request) instead of
 * one request each, which Resend's per-second limit would partly refuse.
 */
async function deliver(to: string[], subject: string, text: string): Promise<boolean> {
  if (to.length === 1) return post("/emails", { from: FROM, to, subject, text });
  let ok = false;
  for (let i = 0; i < to.length; i += 100) {
    const part = to.slice(i, i + 100).map((addr) => ({ from: FROM, to: [addr], subject, text }));
    if (await post("/emails/batch", part)) ok = true;
  }
  return ok;
}

/** Look up email addresses for a set of user ids, skipping any without one. */
export async function emailsForUsers(userIds: string[]): Promise<string[]> {
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  if (ids.length === 0) return [];

  try {
    const supabase = await createServerSideClient();
    const { data } = await supabase.from("users").select("id, email").in("id", ids);
    return (data || []).map((u: any) => u.email).filter(Boolean);
  } catch (err) {
    console.error("could not resolve emails:", err);
    return [];
  }
}

/**
 * Send a message to a set of user ids. Safe to call unconditionally - it
 * resolves addresses, skips silently when mail is not configured, and never
 * throws.
 *
 * Checklist #48: pass `type` (the same notification `type` given to
 * notifyMany) so anyone who has muted email for that category, or turned
 * off email entirely, is left out before anything is sent.
 */
export async function sendMail(opts: {
  userIds: string[];
  subject: string;
  body: string;
  type?: string;
}): Promise<boolean> {
  if (!mailConfigured()) return false;

  let userIds = opts.userIds;
  if (opts.type) {
    try {
      const prefs = await getPrefsMap(await createServerSideClient(), userIds);
      userIds = userIds.filter((uid) => wantsEmail(prefs.get(uid)!, opts.type!));
    } catch {
      /* if prefs can't be read, fail open rather than silently drop mail */
    }
  }
  if (userIds.length === 0) return false;

  const to = await emailsForUsers(userIds);
  if (to.length === 0) return false;

  // Round-1 audit fix: one message per recipient (a shared `to` list disclosed
  // everyone's address to everyone else). deliver() sends them as a batch.
  return deliver(Array.from(new Set(to)), opts.subject, opts.body);
}
