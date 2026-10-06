// Connect, check or disconnect the signed-in person's Telegram.
//
//   GET     is Telegram set up on this deployment, and is my chat connected?
//   POST    give me a one-time link to connect (opens the bot in Telegram)
//   DELETE  disconnect my chat
//
// Only ever acts on the signed-in person's own link.

import { createServerSideClient } from "@/lib/supabase-server";
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/permissions";
import { botUsername, ensureWebhook, telegramConfigured, tg } from "@/lib/telegram";
import { adminConfigured } from "@/lib/supabase-admin";

async function myLink(supabase: any, userId: string) {
  const { data, error } = await supabase
    .from("user_telegram")
    .select("chat_id, username, linked_at")
    .eq("user_id", userId)
    .maybeSingle();
  return { data, missing: !!error };
}

export async function GET() {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Both the bot token and the server key are needed for Telegram to work.
    const configured = telegramConfigured() && adminConfigured();
    const { data, missing } = await myLink(supabase, user.id);
    return NextResponse.json({
      configured,
      migrated: !missing,
      bot: configured ? await botUsername() : null,
      connected: !!data,
      username: data?.username || null,
      linked_at: data?.linked_at || null,
    });
  } catch (error: any) {
    console.error("GET /api/telegram/link failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    if (!telegramConfigured() || !adminConfigured()) {
      return NextResponse.json({ error: "Telegram isn't set up on BusyBee yet - ask your admin" }, { status: 400 });
    }
    const bot = await botUsername();
    if (!bot) {
      return NextResponse.json({ error: "Couldn't reach the BusyBee Telegram bot - check TELEGRAM_BOT_TOKEN" }, { status: 502 });
    }

    // Make sure Telegram knows where to deliver the "Start" press. Cheap when
    // already set; this is what makes connecting work with no manual setup.
    const hook = await ensureWebhook(req.nextUrl.origin);
    if (!hook.ok) {
      return NextResponse.json({ error: `Telegram webhook isn't set: ${hook.detail}` }, { status: 502 });
    }

    const { data: token, error } = await supabase.rpc("bb_telegram_new_token");
    if (error) {
      return NextResponse.json(
        { error: "Telegram connections aren't set up in the database yet - run the Telegram migration" },
        { status: 400 }
      );
    }
    return NextResponse.json({ url: `https://t.me/${bot}?start=${token}`, bot });
  } catch (error: any) {
    console.error("POST /api/telegram/link failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data } = await myLink(supabase, user.id);
    const { error } = await supabase.from("user_telegram").delete().eq("user_id", user.id);
    if (error) throw error;
    if (data?.chat_id) {
      await tg("sendMessage", {
        chat_id: Number(data.chat_id),
        text: "This chat is no longer connected to BusyBee. You won't get alerts here until you connect again from Settings.",
      });
    }
    return NextResponse.json({ connected: false });
  } catch (error: any) {
    console.error("DELETE /api/telegram/link failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
