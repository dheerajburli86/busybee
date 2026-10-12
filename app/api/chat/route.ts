import { createServerSideClient } from "@/lib/supabase-server";
import { after, NextResponse } from "next/server";
import { requireUser } from "@/lib/permissions";
import { roomsFor } from "@/lib/chat";
import { attachNames } from "@/lib/names";
import { createAdminClient } from "@/lib/supabase-admin";
import { pushToUsers } from "@/lib/push";

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

    if (!q && !roomId) return NextResponse.json({ error: "room_id or q required" }, { status: 400 });

    // One room's messages: read them while checking the room is yours (the
    // database only returns rooms you may read anyway).
    const roomMessages = () => {
      let query = supabase.from("chat_messages").select("id, content, author_id, room_id, created_at").eq("room_id", roomId);
      if (after) query = query.gt("created_at", after);
      return query.order("created_at", { ascending: false }).limit(200);
    };
    const [rooms, early] = await Promise.all([roomsFor(supabase, user.id), !q && roomId ? roomMessages() : Promise.resolve(null)]);
    const allowed = rooms.map((r) => r.id);
    if (roomId && !allowed.includes(roomId)) return NextResponse.json({ error: "Room not found" }, { status: 404 });
    if (!allowed.length) return NextResponse.json({ messages: [], me: user.id });

    let result: any = early;
    if (q) {
      // Escape the characters PostgREST treats specially in a pattern.
      const safe = q.replace(/[%_,()]/g, " ");
      result = await supabase
        .from("chat_messages")
        .select("id, content, author_id, room_id, created_at")
        .in("room_id", roomId ? [roomId] : allowed)
        .ilike("content", `%${safe}%`)
        .order("created_at", { ascending: false })
        .limit(100);
    }
    const { data, error } = result;
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

    // Pop-up on the phones of everyone else in a private chat or a room they
    // were added to - like any messaging app. The big organisation and
    // project rooms don't pop up (too noisy); they show a dot instead.
    if (room.kind === "private" || room.kind === "custom") {
      const author = named?.author_name || "Someone";
      after(async () => {
        const db = createAdminClient();
        if (!db) return;
        const { data: members } = await db.from("chat_room_members").select("user_id").eq("room_id", room.id);
        const to = (members || []).map((m: any) => m.user_id).filter((id: string) => id && id !== user.id);
        if (!to.length) return;
        await pushToUsers(to, {
          title: room.kind === "private" ? `💬 ${author}` : `💬 ${author} in ${room.name}`,
          body: data.content,
          url: `/chat?room=${room.id}`,
          tag: `chat-${room.id}`,
        });
      });
    }
    return NextResponse.json(named);
  } catch (error: any) {
    console.error("POST /api/chat failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
