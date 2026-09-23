import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/permissions";
import { roomsFor } from "@/lib/chat";
import { attachNames } from "@/lib/names";

// Messages in a room, or a search across every room you can see.
//   GET /api/chat?room_id=<id>[&after=<iso>]
//   GET /api/chat?q=<text>[&room_id=<id>]
export async function GET(req: Request) {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const url = new URL(req.url);
    const roomId = url.searchParams.get("room_id");
    const q = (url.searchParams.get("q") || "").trim();
    const after = url.searchParams.get("after");

    const rooms = await roomsFor(supabase, user.id);
    const allowed = rooms.map((r) => r.id);
    if (roomId && !allowed.includes(roomId)) return NextResponse.json({ error: "Room not found" }, { status: 404 });
    if (!allowed.length) return NextResponse.json({ messages: [], me: user.id });

    let query = supabase
      .from("chat_messages")
      .select("id, content, author_id, room_id, created_at")
      .in("room_id", roomId ? [roomId] : allowed);

    if (q) {
      // Escape the characters PostgREST treats specially in a pattern.
      const safe = q.replace(/[%_,()]/g, " ");
      query = query.ilike("content", `%${safe}%`).order("created_at", { ascending: false }).limit(100);
    } else {
      if (!roomId) return NextResponse.json({ error: "room_id or q required" }, { status: 400 });
      if (after) query = query.gt("created_at", after);
      query = query.order("created_at", { ascending: false }).limit(200);
    }

    const { data, error } = await query;
    if (error) throw error;

    const rows = q ? data || [] : (data || []).reverse();
    const names = new Map(rooms.map((r) => [r.id, r.name]));
    const withRoom = rows.map((m: any) => ({ ...m, room_name: names.get(m.room_id) || "" }));
    return NextResponse.json({ messages: await attachNames(supabase, withRoom, "author_id", "author_name"), me: user.id });
  } catch (error: any) {
    console.error("GET /api/chat failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { content, room_id } = await req.json();
    if (!content || !content.trim()) return NextResponse.json({ error: "Message is empty" }, { status: 400 });
    if (content.length > 4000) return NextResponse.json({ error: "Message is too long" }, { status: 400 });

    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const rooms = await roomsFor(supabase, user.id);
    const room = rooms.find((r) => r.id === room_id);
    if (!room) return NextResponse.json({ error: "Room not found" }, { status: 404 });

    const { data, error } = await supabase
      .from("chat_messages")
      .insert({ desk_id: room.desk_id, room_id: room.id, channel: room.name, author_id: user.id, content: content.trim() })
      .select("id, content, author_id, room_id, created_at")
      .single();
    if (error) throw error;

    const [named] = await attachNames(supabase, [data], "author_id", "author_name");
    return NextResponse.json(named);
  } catch (error: any) {
    console.error("POST /api/chat failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
