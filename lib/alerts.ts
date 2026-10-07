// One place that sends an alert on every channel: the in-app bell, email and
// Telegram. lib/permissions.ts notifyMany() is a thin wrapper over this, so
// every route that already notifies people gets all three channels.
//
// Rules, per person and per channel:
//   * their own settings decide (Settings page), except pay alerts, which
//     nobody can switch off - see ALWAYS_DELIVERED
//   * email skips routine edits (EMAIL_QUIET) so it stays worth reading
//   * a channel that isn't configured (no email provider, no
//     TELEGRAM_BOT_TOKEN) is skipped silently
//   * a failure on one channel never stops the others, and never fails the
//     request that caused the alert
//   * email and Telegram go out just AFTER the response (Next's after()), so a
//     slow mail or Telegram server never makes clicking a button slow

import { after } from "next/server";
import { deliver, mailConfigured } from "@/lib/email";
import { createAdminClient } from "@/lib/supabase-admin";
import { appUrl, sendToChats, telegramConfigured } from "@/lib/telegram";
import {
  EMAIL_QUIET,
  NotificationPrefs,
  getPrefsMap,
  normalizeRow,
  wantsEmail,
  wantsInApp,
  wantsTelegram,
} from "@/lib/notifications";

export type Alert = {
  task_id?: string | null;
  type: string;
  title: string;
  message: string;
  /** Override the email's subject/body, or `false` for no email at all. */
  email?: { subject?: string; body?: string } | false;
  /** `false` when the caller has already written the in-app notification itself. */
  in_app?: false;
};

export type AlertResult = { in_app: number; email: number; telegram: number; in_app_error?: string };

type Target = { email: string | null; chat: number | null; prefs: NotificationPrefs };

/**
 * Contact details and preferences for a set of people, read with the service
 * key through bb_alert_targets() (server only). Without the service key or
 * before the migration has run, falls back to what the signed-in user can
 * read directly: bell and email still work, Telegram is skipped.
 */
async function targets(supabase: any, ids: string[]): Promise<Map<string, Target>> {
  const out = new Map<string, Target>();
  const admin = createAdminClient();
  const rpc = admin
    ? await admin.rpc("bb_alert_targets", { p_users: ids })
    : { data: null, error: { message: "no service key" } };
  if (!rpc.error && Array.isArray(rpc.data)) {
    for (const r of rpc.data) {
      out.set(r.user_id, {
        email: r.email || null,
        chat: r.telegram_chat_id != null ? Number(r.telegram_chat_id) : null,
        prefs: normalizeRow(r),
      });
    }
  } else {
    const prefs = await getPrefsMap(supabase, ids);
    let emails = new Map<string, string>();
    try {
      const { data } = await supabase.from("users").select("id, email").in("id", ids);
      emails = new Map((data || []).map((u: any) => [u.id, u.email]));
    } catch {
      /* no email addresses - in-app still goes out */
    }
    ids.forEach((id) => out.set(id, { email: emails.get(id) || null, chat: null, prefs: prefs.get(id)! }));
  }
  // Anyone the lookup didn't return still gets the in-app alert with
  // default settings, exactly as before this file existed.
  ids.forEach((id) => {
    if (!out.has(id)) out.set(id, { email: null, chat: null, prefs: normalizeRow(null) });
  });
  return out;
}

function emailBody(a: Alert, body: string): string {
  const base = appUrl();
  const lines = [body];
  if (base) {
    lines.push("", `Open in BusyBee: ${base}/dashboard${a.task_id ? `?task=${a.task_id}` : ""}`);
    lines.push("", `Choose which alerts you get: ${base}/settings`);
  }
  return lines.join("\n");
}

export async function sendAlert(supabase: any, userIds: string[], a: Alert): Promise<AlertResult> {
  const result: AlertResult = { in_app: 0, email: 0, telegram: 0 };
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  if (ids.length === 0) return result;

  const who = await targets(supabase, ids);

  // 1. The bell. Written first: it's the record of what was sent.
  const rows = ids
    .filter((id) => a.in_app !== false && wantsInApp(who.get(id)!.prefs, a.type))
    .map((id) => ({
      user_id: id,
      task_id: a.task_id ?? null,
      type: a.type,
      title: a.title,
      message: a.message,
      read: false,
    }));
  if (rows.length) {
    try {
      const { error } = await supabase.from("notifications").insert(rows);
      if (error) result.in_app_error = error.message;
      else result.in_app = rows.length;
    } catch (err: any) {
      result.in_app_error = err?.message || "could not save the notification";
    }
  }

  // 2 + 3. Email and Telegram, side by side.
  const wantMail =
    mailConfigured() && a.email !== false && (!EMAIL_QUIET.includes(a.type) || !!a.email);
  const mailTo = wantMail
    ? Array.from(
        new Set(
          ids
            .filter((id) => wantsEmail(who.get(id)!.prefs, a.type))
            .map((id) => who.get(id)!.email)
            .filter((e): e is string => !!e)
        )
      )
    : [];
  const chats = telegramConfigured()
    ? ids
        .filter((id) => wantsTelegram(who.get(id)!.prefs, a.type))
        .map((id) => who.get(id)!.chat)
        .filter((c): c is number => c != null)
    : [];

  const subject = (a.email && a.email.subject) || a.title;
  const body = emailBody(a, (a.email && a.email.body) || a.message);

  if (!mailTo.length && !chats.length) return result;

  const send = async () => {
    const [mailed, sent] = await Promise.allSettled([
      mailTo.length ? deliver(mailTo, subject, body) : Promise.resolve(false),
      chats.length ? sendToChats(chats, a) : Promise.resolve(0),
    ]);
    if (mailed.status === "rejected") console.error("alert email failed:", mailed.reason);
    if (sent.status === "rejected") console.error("alert telegram failed:", sent.reason);
  };

  // Counts below are what was queued; delivery happens after the response.
  result.email = mailTo.length;
  result.telegram = Array.from(new Set(chats)).length;
  try {
    after(send);
  } catch {
    // Not inside a request (shouldn't happen) - just send now.
    await send();
  }
  return result;
}
