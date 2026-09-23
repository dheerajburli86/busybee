import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import { deny, getMemberships, requireUser, roleIn, SUPER_ROLES } from "@/lib/permissions";
import { roomsFor } from "@/lib/chat";

export async function GET() {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const rooms = await roomsFor(supabase, user.id);
    const ids = rooms.map((r) => r.id);
    const { data: members } = ids.length
      ? await supabase.from("chat_room_members").select("room_id, user_id").in("room_id", ids)
      : { data: [] };

    // Latest message time per room, for sorting and unread dots.
    const latest: Record<string, string> = {};
    if (ids.length) {
      const { data: recent } = await supabase
        .from("chat_messages")
        .select("room_id, created_at")
        .in("room_id", ids)
        .order("created_at", { ascending: false })
        .limit(500);
      (recent || []).forEach((m: any) => (latest[m.room_id] ||= m.created_at));
    }

    return NextResponse.json({
      me: user.id,
      rooms: rooms.map((r) => ({
        ...r,
        members: (members || []).filter((m: any) => m.room_id === r.id).map((m: any) => m.user_id),
        last_message_at: latest[r.id] || null,
      })),
    });
  } catch (error: any) {
    console.error("GET /api/chat/rooms failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

// Create a private chat (you + at least one other person) or a custom room.
export async function POST(req: Request) {
  try {
    const { name, kind, user_ids } = await req.json();
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const memberships = await getMemberships(supabase, user.id);
    const deskId = memberships[0]?.desk_id;
    if (!deskId) return NextResponse.json({ error: "No desk found" }, { status: 400 });

    const roomKind = kind === "custom" ? "custom" : "private";
    const others: string[] = Array.from(new Set((Array.isArray(user_ids) ? user_ids : []).filter((x: string) => x && x !== user.id)));
    if (others.length === 0) return NextResponse.json({ error: "Pick at least one other person" }, { status: 400 });

    // Everyone must be on the same desk.
    const { data: deskMates } = await supabase.from("desk_members").select("user_id").eq("desk_id", deskId).in("user_id", others);
    const valid = (deskMates || []).map((d: any) => d.user_id);
    if (valid.length !== others.length) return NextResponse.json({ error: "Someone you picked isn't on this desk" }, { status: 400 });

    // Reuse an existing one-to-one chat instead of making duplicates.
    if (roomKind === "private" && valid.length === 1) {
      const { data: mine } = await supabase.from("chat_room_members").select("room_id").eq("user_id", user.id);
      const { data: theirs } = await supabase.from("chat_room_members").select("room_id").eq("user_id", valid[0]);
      const shared = (mine || []).map((m: any) => m.room_id).filter((id: string) => (theirs || []).some((t: any) => t.room_id === id));
      if (shared.length) {
        const { data: rooms } = await supabase.from("chat_rooms").select("*").in("id", shared).eq("kind", "private");
        for (const r of rooms || []) {
          const { count } = await supabase.from("chat_room_members").select("id", { count: "exact", head: true }).eq("room_id", r.id);
          if (count === 2) return NextResponse.json({ ...r, members: [user.id, valid[0]], existing: true });
        }
      }
    }

    let roomName = (name || "").trim();
    if (!roomName) {
      const { data: people } = await supabase.from("users").select("full_name, email").in("id", valid);
      roomName = (people || []).map((p: any) => p.full_name || p.email).join(", ").slice(0, 80) || "Private chat";
    }

    const { data: room, error } = await supabase
      .from("chat_rooms")
      .insert({ desk_id: deskId, name: roomName, kind: roomKind, created_by: user.id })
      .select("*")
      .single();
    if (error) throw error;

    const all = [user.id, ...valid];
    await supabase.from("chat_room_members").insert(all.map((user_id) => ({ room_id: room.id, user_id })));
    return NextResponse.json({ ...room, members: all });
  } catch (error: any) {
    console.error("POST /api/chat/rooms failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

// Add people to, or delete, a private/custom room you created.
export async function PUT(req: Request) {
  try {
    const { room_id, add_user_ids, name } = await req.json();
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: room } = await supabase.from("chat_rooms").select("*").eq("id", room_id).maybeSingle();
    const memberships = await getMemberships(supabase, user.id);
    if (!room || !memberships.some((m) => m.desk_id === room.desk_id)) return NextResponse.json({ error: "Room not found" }, { status: 404 });
    if (!["private", "custom"].includes(room.kind)) return deny("Project and organisation rooms are managed automatically.");
    if (room.created_by !== user.id && !SUPER_ROLES.includes(roleIn(memberships, room.desk_id))) {
      return deny("Only the person who made this room can change it.");
    }

    if (name?.trim()) await supabase.from("chat_rooms").update({ name: name.trim() }).eq("id", room.id);
    const add: string[] = Array.isArray(add_user_ids) ? add_user_ids : [];
    if (add.length) {
      const { data: deskMates } = await supabase.from("desk_members").select("user_id").eq("desk_id", room.desk_id).in("user_id", add);
      const rows = (deskMates || []).map((d: any) => ({ room_id: room.id, user_id: d.user_id }));
      if (rows.length) await supabase.from("chat_room_members").upsert(rows, { onConflict: "room_id,user_id", ignoreDuplicates: true });
    }
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("PUT /api/chat/rooms failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { room_id } = await req.json();
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: room } = await supabase.from("chat_rooms").select("*").eq("id", room_id).maybeSingle();
    const memberships = await getMemberships(supabase, user.id);
    if (!room || !memberships.some((m) => m.desk_id === room.desk_id)) return NextResponse.json({ error: "Room not found" }, { status: 404 });
    if (!["private", "custom"].includes(room.kind)) return deny("This room can't be deleted.");
    if (room.created_by !== user.id && !SUPER_ROLES.includes(roleIn(memberships, room.desk_id))) {
      return deny("Only the person who made this room can delete it.");
    }
    await supabase.from("chat_messages").delete().eq("room_id", room.id);
    await supabase.from("chat_rooms").delete().eq("id", room.id);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("DELETE /api/chat/rooms failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
