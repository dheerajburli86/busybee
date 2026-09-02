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

const FROM = process.env.MAIL_FROM || "BusyBee <onboarding@resend.dev>";

export function mailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

async function deliver(to: string[], subject: string, text: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: FROM, to, subject, text }),
    });

    if (!res.ok) {
      // A failed email must never take down the request that triggered it.
      console.error("email send failed:", res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error("email send threw:", err);
    return false;
  }
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
 */
export async function sendMail(opts: {
  userIds: string[];
  subject: string;
  body: string;
}): Promise<boolean> {
  if (!mailConfigured()) return false;

  const to = await emailsForUsers(opts.userIds);
  if (to.length === 0) return false;

  return deliver(to, opts.subject, opts.body);
}
