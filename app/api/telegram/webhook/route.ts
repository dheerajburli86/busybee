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
