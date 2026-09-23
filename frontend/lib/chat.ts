// Chat rooms (checklist #27 / #28): organisation-wide, per-project,
// private (two or more people) and custom rooms.

import { getMemberships, managedProjectIds, roleIn, userProjectIds, SUPER_ROLES } from "@/lib/permissions";

export type Room = {
  id: string;
  desk_id: string;
  name: string;
  kind: "org" | "project" | "private" | "custom";
  project_id: string | null;
  created_by: string | null;
};

// When each desk's default rooms were last checked (per server instance).
const lastEnsured = new Map<string, number>();

/**
 * Make sure the org room and a room for each project exist. Checked at most
 * once a minute per desk (pass `force` right after creating a project). The
 * database function does it in one step and can see every room; the fallback
 * below is for a database without it.
 */
export async function ensureDefaultRooms(supabase: any, deskId: string, force = false) {
  const now = Date.now();
  if (!force && now - (lastEnsured.get(deskId) || 0) < 60000) return;
  lastEnsured.set(deskId, now);

  const { error: rpcError } = await supabase.rpc("bb_ensure_default_rooms", { p_desk: deskId });
  if (!rpcError) return;

  const [{ data: rooms }, { data: projects }] = await Promise.all([
    supabase.from("chat_rooms").select("id, kind, project_id, name").eq("desk_id", deskId),
    supabase.from("projects").select("id, name").eq("desk_id", deskId),
  ]);
  const have = rooms || [];
  const missing: any[] = [];
  if (!have.some((r: any) => r.kind === "org")) missing.push({ desk_id: deskId, name: "general", kind: "org" });
  (projects || []).forEach((p: any) => {
    if (!have.some((r: any) => r.kind === "project" && r.project_id === p.id)) {
      missing.push({ desk_id: deskId, name: p.name, kind: "project", project_id: p.id });
    }
  });
  // One at a time: if two people open chat at the same moment, the database
  // keeps a single room per project and the second insert just fails.
  for (const room of missing) await supabase.from("chat_rooms").insert(room);
}

/**
 * Rooms this user may read and post in. The database applies the same rule
 * (can_access_room), so this list and what the database returns agree.
 */
export async function roomsFor(supabase: any, userId: string): Promise<Room[]> {
  const memberships = await getMemberships(supabase, userId);
  const deskIds = memberships.map((m) => m.desk_id);
  if (!deskIds.length) return [];

  for (const d of deskIds) await ensureDefaultRooms(supabase, d);

  const [{ data: rooms }, { data: mine }, myProjects, managed] = await Promise.all([
    supabase.from("chat_rooms").select("*").in("desk_id", deskIds).order("created_at"),
    supabase.from("chat_room_members").select("room_id").eq("user_id", userId),
    userProjectIds(supabase, userId),
    managedProjectIds(supabase, userId),
  ]);
  const memberOf = new Set((mine || []).map((m: any) => m.room_id));

  return (rooms || []).filter((r: any) => {
    const isSuper = SUPER_ROLES.includes(roleIn(memberships, r.desk_id));
    switch (r.kind) {
      case "org":
        return true;
      case "project":
        return isSuper || myProjects.includes(r.project_id) || managed.includes(r.project_id);
      default:
        return memberOf.has(r.id) || r.created_by === userId;
    }
  });
}
