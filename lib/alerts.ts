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
import { loadTaskCard, renderEmail, whyYou } from "@/lib/mailfmt";
import { involvedIn, overseersOf, overseerWording } from "@/lib/oversight";
import { formatForPeople } from "@/lib/format";
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

type Target = { email: string | null; chat: number | null; prefs: NotificationPrefs; name?: string | null };

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

  // 2 + 3. Email and Telegram, side by side - after the response, so a slow
  // mail or Telegram server never slows a click. Who gets what is decided
  // there too (see lib/oversight.ts): people part of the task get the alert,
  // the desk's overseers get their own "here's what happened" version.
  const wantMail = mailConfigured() && a.email !== false && (!EMAIL_QUIET.includes(a.type) || !!a.email);
  const subject = (a.email && a.email.subject) || a.title;
  const anyChannel = mailConfigured() || telegramConfigured();
  if (!anyChannel) return result;

  const send = async () => {
    const db = createAdminClient() || supabase;
    const base = appUrl();
    const now = formatForPeople(new Date().toISOString());

    const actorId: string | null = await supabase.auth
      .getUser()
      .then((r: any) => r?.data?.user?.id || null)
      .catch(() => null);
    const [card, involved, names] = await Promise.all([
      a.task_id ? loadTaskCard(db, a.task_id) : Promise.resolve(null),
      a.task_id ? involvedIn(db, a.task_id) : Promise.resolve(null),
      db
        .from("users")
        .select("id, full_name, email")
        .in("id", Array.from(new Set([...ids, ...(actorId ? [actorId] : [])])))
        .then((r: any) => new Map<string, string>((r.data || []).map((u: any) => [u.id, u.full_name || u.email])))
        .catch(() => new Map<string, string>()),
    ]);
    const actor = actorId ? names.get(actorId) || null : null;
    const overseers = involved ? (await overseersOf(db, involved.desk_id)).filter((x) => x !== actorId) : [];
    // The head (Shankar) gets exactly one email a day - the 8 PM summary from
    // the scheduler - and no other email or Telegram message from BusyBee.
    const heads = new Set(involved ? await overseersOf(db, involved.desk_id) : []);

    // People part of the task (or any alert that isn't about a task).
    const isPart = (id: string) => !involved || involved.ids.has(id);
    const fyi = overseers.filter((id) => !(involved && involved.ids.has(id)));

    const mailIds = wantMail
      ? ids.filter((id) => isPart(id) && !fyi.includes(id) && !heads.has(id) && wantsEmail(who.get(id)!.prefs, a.type) && !!who.get(id)!.email)
      : [];
    const chats = telegramConfigured()
      ? ids
          .filter((id) => isPart(id) && !fyi.includes(id) && !heads.has(id) && wantsTelegram(who.get(id)!.prefs, a.type))
          .map((id) => who.get(id)!.chat)
          .filter((c): c is number => c != null)
      : [];

    const jobs: Promise<unknown>[] = [];
    const extra = a.email && a.email.body && a.email.body !== a.message ? [a.email.body] : [];
    const cta = base
      ? { url: `${base}/dashboard${a.task_id ? `?task=${a.task_id}` : ""}`, label: a.task_id ? "Open the task in BusyBee" : "Open BusyBee" }
      : null;

    for (const id of mailIds) {
      const first = String(names.get(id) || "").split(" ")[0];
      const { text, html } = renderEmail({
        greeting: first ? `Hi ${first},` : null,
        headline: a.message,
        meta: actor ? `By ${actor} · ${now}` : now,
        paragraphs: extra,
        card,
        cta,
        why: whyYou(card, id),
        settingsUrl: base ? `${base}/settings` : null,
      });
      jobs.push(deliver([who.get(id)!.email!], subject, text, html));
    }
    if (chats.length) jobs.push(sendToChats(chats, a));

    // The overseers' copy: everything except routine edits.
    if (fyi.length && !["updated", "subtask_completed", "private_comment"].includes(a.type)) {
      const w = overseerWording(a.type, a.title, a.message, card, actor);
      const fyiWho = await targets(supabase, fyi);
      const fyiNames = await db
        .from("users")
        .select("id, full_name, email")
        .in("id", fyi)
        .then((r: any) => new Map<string, string>((r.data || []).map((u: any) => [u.id, u.full_name || u.email])))
        .catch(() => new Map<string, string>());
      const bell = fyi
        .filter((id) => !ids.includes(id))
        .map((id) => ({ user_id: id, task_id: a.task_id ?? null, type: a.type, title: card ? `Update: ${card.title}` : a.title, message: w.headline, read: false }));
      if (bell.length) jobs.push(Promise.resolve(supabase.from("notifications").insert(bell)));
      const subj = card ? `${card.assignee || "Task"}: ${card.title} - ${a.title}` : a.title;
      // Bell only: the head's email is the 8 PM summary.
      for (const id of [] as string[]) {
        const t = fyiWho.get(id);
        if (!t) continue;
        if (mailConfigured() && t.email && t.prefs.email_enabled !== false) {
          const first = String(fyiNames.get(id) || "").split(" ")[0];
          const { text, html } = renderEmail({
            greeting: first ? `Hi ${first},` : null,
            headline: w.headline,
            meta: actor ? `By ${actor} · ${now}` : now,
            paragraphs: w.details && w.details !== w.headline ? [`Details: ${w.details}`] : [],
            card,
            cta,
            why: "You're getting this because you oversee all work on BusyBee, so you're told about everything that happens on every task.",
            settingsUrl: base ? `${base}/settings` : null,
          });
          jobs.push(deliver([t.email], subj, text, html));
        }
        if (telegramConfigured() && t.chat != null) {
          jobs.push(sendToChats([t.chat], { ...a, title: card ? `Update: ${card.title}` : a.title, message: w.headline }));
        }
      }
    }

    const results = await Promise.allSettled(jobs);
    results.forEach((r) => r.status === "rejected" && console.error("alert delivery failed:", r.reason));
  };

  // Counts are what could go out; who exactly is decided after the response.
  result.email = wantMail ? ids.filter((id) => wantsEmail(who.get(id)!.prefs, a.type) && !!who.get(id)!.email).length : 0;
  result.telegram = telegramConfigured() ? ids.filter((id) => who.get(id)!.chat != null).length : 0;
  try {
    after(send);
  } catch {
    // Not inside a request (shouldn't happen) - just send now.
    await send();
  }
  return result;
}
