// Send the signed-in person a test message on Telegram (Settings page button).

import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/permissions";
import { sendToChats, telegramConfigured } from "@/lib/telegram";

export async function POST() {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!telegramConfigured()) return NextResponse.json({ error: "Telegram isn't set up on BusyBee yet" }, { status: 400 });

    const { data } = await supabase.from("user_telegram").select("chat_id").eq("user_id", user.id).maybeSingle();
    if (!data?.chat_id) return NextResponse.json({ error: "Connect Telegram first" }, { status: 400 });

    const sent = await sendToChats([Number(data.chat_id)], {
      type: "test",
      title: "Test alert",
      message: "Telegram alerts from BusyBee are working.",
    });
    if (!sent) {
      return NextResponse.json(
        { error: "Telegram didn't accept the message - if you blocked the bot, unblock it, or disconnect and connect again" },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("POST /api/telegram/test failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
