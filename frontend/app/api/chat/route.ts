import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";

// SOW #5: internal chat, scoped to the user's desk.
async function deskFor(supabase: any, userId: string) {
  const { data } = await supabase
    .from("desk_members")
    .select("desk_id")
    .eq("user_id", userId)
    .limit(1)
    .single();
  return data?.desk_id ?? null;
}

export async function GET(req: Request) {
  try {
    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const url = new URL(req.url);
    const channel = url.searchParams.get("channel") || "general";

    const deskId = await deskFor(supabase, user.id);
    if (!deskId) return NextResponse.json({ messages: [], me: user.id });

    const { data, error } = await supabase
      .from("chat_messages")
      .select("id, content, author_id, channel, created_at")
      .eq("desk_id", deskId)
      .eq("channel", channel)
      .order("created_at", { ascending: true })
      .limit(200);

    if (error) throw error;
    return NextResponse.json({ messages: data || [], me: user.id });
  } catch (error: any) {
    console.error("GET /api/chat failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { content, channel } = await req.json();
    if (!content || !content.trim()) {
      return NextResponse.json({ error: "Message is empty" }, { status: 400 });
    }

    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const deskId = await deskFor(supabase, user.id);
    if (!deskId) return NextResponse.json({ error: "No desk found" }, { status: 400 });

    const { data, error } = await supabase
      .from("chat_messages")
      .insert({
        desk_id: deskId,
        channel: channel || "general",
        author_id: user.id,
        content: content.trim(),
      })
      .select("id, content, author_id, channel, created_at")
      .single();

    if (error) throw error;
    return NextResponse.json(data);
  } catch (error: any) {
    console.error("POST /api/chat failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
