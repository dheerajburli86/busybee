import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import { getMemberships, requireUser } from "@/lib/permissions";

// Online/offline status (checklist #27). The app pings every minute while a
// tab is open; anyone seen in the last two minutes counts as online.
const ONLINE_MS = 2 * 60 * 1000;

export async function POST() {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    await supabase.from("user_presence").upsert({ user_id: user.id, last_seen_at: new Date().toISOString() });
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function GET() {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const memberships = await getMemberships(supabase, user.id);
    const deskIds = memberships.map((m) => m.desk_id);
    if (!deskIds.length) return NextResponse.json({ presence: {} });
    const { data: mates } = await supabase.from("desk_members").select("user_id").in("desk_id", deskIds);
    const ids = Array.from(new Set((mates || []).map((m: any) => m.user_id)));
    const { data } = ids.length
      ? await supabase.from("user_presence").select("user_id, last_seen_at").in("user_id", ids)
      : { data: [] };

    const now = Date.now();
    const presence: Record<string, { online: boolean; last_seen_at: string }> = {};
    (data || []).forEach((p: any) => {
      presence[p.user_id] = { online: now - new Date(p.last_seen_at).getTime() < ONLINE_MS, last_seen_at: p.last_seen_at };
    });
    return NextResponse.json({ presence });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
