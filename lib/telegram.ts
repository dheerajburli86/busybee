// Telegram alerts: the phone half of "every alert goes by email and phone".
//
// Uses the Bot API over plain fetch - no package to install. Until
// TELEGRAM_BOT_TOKEN is set every function here is a no-op that returns
// false, so the app works exactly as before with the token missing.
//
// A person is reachable once they have connected their chat in Settings
// (see /api/telegram/link and /api/telegram/webhook). Telegram does not let a
// bot message anybody who hasn't pressed Start on it first, which is why a
// chat id can't simply be typed in by an admin.

import { createHash } from "crypto";

const API = "https://api.telegram.org";

export function telegramConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim());
}

function token(): string {
  return (process.env.TELEGRAM_BOT_TOKEN || "").trim();
}

/**
 * The secret Telegram echoes back on every webhook call, derived from the bot
 * token so there's no second secret to configure. Anyone without the bot
 * token can't produce it, so a forged "update" is rejected.
 */
export function webhookSecret(): string {
  return createHash("sha256").update(`busybee-telegram-webhook:${token()}`).digest("hex").slice(0, 48);
}

/** The public address of this deployment, for links in messages and the webhook. */
export function appUrl(fallbackOrigin?: string): string {
  const explicit = (process.env.APP_URL || "").trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  const vercel = (process.env.VERCEL_PROJECT_PRODUCTION_URL || "").trim();
  if (vercel) return `https://${vercel.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  return (fallbackOrigin || "").replace(/\/+$/, "");
}

export function escapeHtml(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Call a Bot API method. Never throws; returns Telegram's JSON or null. */
export async function tg(method: string, payload: Record<string, unknown> = {}): Promise<any | null> {
  if (!telegramConfigured()) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${API}/bot${token()}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json().catch(() => null);
      if (res.status === 429 && attempt === 0) {
        const wait = Math.min(Number(data?.parameters?.retry_after) || 1, 2);
        await sleep(wait * 1000);
        continue;
      }
      if (!res.ok || !data?.ok) {
        // 403 = they blocked the bot; 400 "chat not found" = stale link. Both
        // are the person's choice, not an error worth failing a request over.
        console.error(`telegram ${method} failed:`, res.status, data?.description);
      }
      return data;
    } catch (err) {
      console.error(`telegram ${method} threw:`, err);
      return null;
    }
  }
  return null;
}

let botNameCache: Promise<string | null> | null = null;

/** The bot's @username, read from Telegram itself so it isn't another setting. */
export async function botUsername(): Promise<string | null> {
  if (!telegramConfigured()) return null;
  if (!botNameCache) {
    botNameCache = tg("getMe").then((d) => (d?.ok ? d.result?.username || null : null));
    const name = await botNameCache;
    if (!name) botNameCache = null; // don't remember a failure
    return name;
  }
  return botNameCache;
}

const ICONS: Record<string, string> = {
  adjustment_reward: "💰",
  adjustment_penalty: "⚠️",
  adjustment_voided: "↩️",
  assigned: "📌",
  overdue: "🚨",
  review_approved: "✅",
  review_sent_back: "↩️",
  review_pending: "🔍",
  deadline_declined: "⏳",
  extension_request: "⏳",
  extension_reviewed: "📅",
  mention: "💬",
  private_comment: "🔒",
};

function iconFor(type: string): string {
  if (ICONS[type]) return ICONS[type];
  if (type.startsWith("reminder") || type === "checklist_due") return "⏰";
  if (type.startsWith("review_pending")) return "🔍";
  return "🔔";
}

/** Format one alert for Telegram (HTML parse mode). */
export function formatAlert(n: { type: string; title: string; message: string }): string {
  const body = String(n.message || "").slice(0, 3500);
  return `${iconFor(n.type)} <b>${escapeHtml(n.title)}</b>\n${escapeHtml(body)}`;
}

/**
 * Send one alert to a set of chats, in parallel. Returns how many were
 * delivered. A link button is added when there's an https address to open.
 */
export async function sendToChats(
  chatIds: number[],
  n: { type: string; title: string; message: string; task_id?: string | null }
): Promise<number> {
  if (!telegramConfigured() || chatIds.length === 0) return 0;
  const base = appUrl();
  const link = base.startsWith("https://") ? `${base}/dashboard${n.task_id ? `?task=${n.task_id}` : ""}` : "";
  const text = formatAlert(n);

  const results = await Promise.allSettled(
    Array.from(new Set(chatIds)).map((chat_id) =>
      tg("sendMessage", {
        chat_id,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(link ? { reply_markup: { inline_keyboard: [[{ text: "Open in BusyBee", url: link }]] } } : {}),
      })
    )
  );
  return results.filter((r) => r.status === "fulfilled" && r.value?.ok).length;
}

/** Point Telegram at this deployment's webhook, if it isn't already. */
export async function ensureWebhook(
  origin?: string,
  force = false
): Promise<{ ok: boolean; url: string; detail: string }> {
  if (!telegramConfigured()) return { ok: false, url: "", detail: "TELEGRAM_BOT_TOKEN is not set" };
  const base = appUrl(origin);
  if (!base.startsWith("https://")) {
    return { ok: false, url: "", detail: "No https address for this deployment - set APP_URL" };
  }
  const url = `${base}/api/telegram/webhook`;
  const info = await tg("getWebhookInfo");
  // "force" re-sends the secret too (needed if the bot token was ever changed,
  // since Telegram doesn't reveal which secret it is using).
  if (!force && info?.ok && info.result?.url === url) return { ok: true, url, detail: "already set" };

  const set = await tg("setWebhook", {
    url,
    secret_token: webhookSecret(),
    allowed_updates: ["message"],
  });
  if (!set?.ok) return { ok: false, url, detail: set?.description || "Telegram refused the webhook" };

  await tg("setMyCommands", {
    commands: [
      { command: "start", description: "Connect this chat to BusyBee" },
      { command: "help", description: "How BusyBee alerts work" },
    ],
  });
  return { ok: true, url, detail: "set" };
}
