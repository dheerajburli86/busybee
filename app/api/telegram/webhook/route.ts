// Telegram calls this when someone messages the BusyBee bot.
//
// The only thing it acts on is "/start <token>" from a one-time link made in
// Settings: that proves the chat belongs to the person who asked for the link,
// and connects them. Everything else gets a short explanation back.
//
// Every call must carry the secret Telegram was given when the webhook was
// registered (lib/telegram.ts webhookSecret); anything else is refused, so
// nobody can post a fake "update" here.

import { createAdminClient } from "@/lib/supabase-admin";
import { NextRequest, NextResponse } from "next/server";
import { escapeHtml, telegramConfigured, tg, webhookSecret } from "@/lib/telegram";
import { timingSafeEqual } from "crypto";

function secretOk(req: NextRequest): boolean {
  const got = Buffer.from(req.headers.get("x-telegram-bot-api-secret-token") || "");
  const want = Buffer.from(webhookSecret());
  return got.length === want.length && timingSafeEqual(got, want);
}

const reply = (chat_id: number, text: string) =>
  tg("sendMessage", { chat_id, text, parse_mode: "HTML", disable_web_page_preview: true });

/** Connect this chat to the BusyBee user added with this @username, if any (and not already connected). */
async function linkByUsername(chatId: number, username: string | undefined): Promise<string | null> {
  if (!username) return null;
  const admin = createAdminClient();
  if (!admin) return null;
  const want = username.toLowerCase();
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error || !data?.users?.length) return null;
    const u = data.users.find((x: any) => String(x.user_metadata?.telegram_username || "").toLowerCase() === want);
    if (u) {
      const { data: has } = await admin.from("user_telegram").select("chat_id").eq("user_id", u.id).maybeSingle();
      if (has && Number(has.chat_id) === chatId) return null;
      await admin.from("user_telegram").upsert({ user_id: u.id, chat_id: chatId, username, linked_at: new Date().toISOString() }, { onConflict: "user_id" });
      return String(u.user_metadata?.full_name || u.email || "there");
    }
    if (data.users.length < 1000) return null;
  }
  return null;
}

export async function POST(req: NextRequest) {
  if (!telegramConfigured() || !secretOk(req)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  // From here on, always answer 200: a non-200 makes Telegram retry the same
  // message over and over.
  try {
    const update = await req.json().catch(() => null);
    const msg = update?.message;
    const chat = msg?.chat;
    const text: string = typeof msg?.text === "string" ? msg.text.trim() : "";
    if (!chat?.id || !text) return NextResponse.json({ ok: true });

    if (chat.type !== "private") {
      await reply(chat.id, "BusyBee alerts only work in a private chat with this bot.");
      return NextResponse.json({ ok: true });
    }

    const [command, ...rest] = text.split(/\s+/);
    // Someone added with their @username (Tasks → Add person): the first
    // message they send the bot connects them.
    if (!(command.toLowerCase().startsWith("/start") && rest[0])) {
      const linked = await linkByUsername(chat.id, msg.from?.username);
      if (linked) {
        await reply(chat.id, `✅ Connected, ${escapeHtml(linked)}. Your BusyBee alerts will arrive here.`);
        return NextResponse.json({ ok: true });
      }
    }
    const cmd = command.toLowerCase().replace(/@.*$/, "");

    if (cmd === "/start") {
      const token = (rest[0] || "").trim();
      if (!token) {
        await reply(
          chat.id,
          "Hi! To get your BusyBee alerts here, open BusyBee → <b>Settings</b> → <b>Connect Telegram</b>, then press Start on the page it opens."
        );
        return NextResponse.json({ ok: true });
      }
      const admin = createAdminClient();
      if (!admin) {
        console.error("telegram webhook: SUPABASE_SERVICE_ROLE_KEY is not set, can't link chats");
        await reply(chat.id, "BusyBee isn't fully set up for Telegram yet. Please tell your admin.");
        return NextResponse.json({ ok: true });
      }
      const { data: name, error } = await admin.rpc("bb_telegram_link", {
        p_token: token,
        p_chat: chat.id,
        p_username: msg.from?.username || null,
      });
      if (error) {
        console.error("bb_telegram_link failed:", error);
        await reply(chat.id, "Something went wrong connecting this chat. Please try again from BusyBee → Settings.");
      } else if (!name) {
        await reply(
          chat.id,
          "That link has expired or was already used. Open BusyBee → <b>Settings</b> → <b>Connect Telegram</b> for a fresh one."
        );
      } else {
        await reply(
          chat.id,
          `✅ Connected, ${escapeHtml(String(name))}.\n\nYour BusyBee alerts - new work, deadlines, reminders, reviews, rewards and penalties - will arrive here as well as by email.\n\nChoose which ones in BusyBee → Settings.`
        );
      }
      return NextResponse.json({ ok: true });
    }

    await reply(
      chat.id,
      "This bot sends your BusyBee alerts. To choose which ones, or to disconnect, open BusyBee → <b>Settings</b>."
    );
  } catch (err) {
    console.error("telegram webhook failed:", err);
  }
  return NextResponse.json({ ok: true });
}
