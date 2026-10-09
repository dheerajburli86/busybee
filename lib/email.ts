// SOW #30 / #39: email alongside in-app notifications.
//
// Two ways to send, whichever is set up:
//   * Gmail - GMAIL_USER plus GMAIL_APP_PASSWORD (a 16-letter app password,
//     not the account password). Sends from that Gmail address over SMTP.
//   * Resend - RESEND_API_KEY, sending from MAIL_FROM on a verified domain.
// Gmail wins if both are set. With neither, the whole thing is a no-op: it
// returns false and the app carries on with in-app notifications only.

import nodemailer from "nodemailer";
import { createServerSideClient } from "@/lib/supabase-server";
import { getPrefsMap, wantsEmail } from "@/lib/notifications";

const gmailUser = () => (process.env.GMAIL_USER || "").trim();
// Google shows app passwords in groups of four with spaces; accept it pasted
// either way.
const gmailPass = () => (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");

export function mailProvider(): "gmail" | "resend" | null {
  if (gmailUser() && gmailPass()) return "gmail";
  if (process.env.RESEND_API_KEY) return "resend";
  return null;
}

export function mailConfigured(): boolean {
  return mailProvider() !== null;
}

/** The address mail goes out from, for the system check. */
export function mailSender(): string {
  if (mailProvider() === "gmail") return `BusyBee <${gmailUser()}>`;
  return process.env.MAIL_FROM || "BusyBee <onboarding@resend.dev>";
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let transport: nodemailer.Transporter | null = null;
function gmail(): nodemailer.Transporter {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: gmailUser(), pass: gmailPass() },
      pool: true,
      maxConnections: 1,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });
  }
  return transport;
}

/** One message per recipient over Gmail, so nobody sees anyone else's address. */
async function viaGmail(to: string[], subject: string, text: string, html?: string): Promise<boolean> {
  let ok = false;
  for (const addr of to) {
    try {
      await gmail().sendMail({ from: mailSender(), to: addr, subject, text, ...(html ? { html } : {}) });
      ok = true;
    } catch (err: any) {
      // A failed email must never take down the request that triggered it.
      console.error("gmail send failed:", addr, err?.responseCode || "", err?.message || err);
      // Bad login fails the same way for everyone - stop rather than repeat it.
      if (err?.code === "EAUTH") return ok;
    }
  }
  return ok;
}

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
 * One message per recipient, so nobody sees anyone else's address. On Resend,
 * several recipients go in one batch request (up to 100 per request).
 */
export async function deliver(to: string[], subject: string, text: string, html?: string): Promise<boolean> {
  const provider = mailProvider();
  if (provider === "gmail") return viaGmail(to, subject, text, html);
  if (provider !== "resend") return false;
  const from = mailSender();
  const extra = html ? { html } : {};
  if (to.length === 1) return post("/emails", { from, to, subject, text, ...extra });
  let ok = false;
  for (let i = 0; i < to.length; i += 100) {
    const part = to.slice(i, i + 100).map((addr) => ({ from, to: [addr], subject, text, ...extra }));
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
