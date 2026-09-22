// Chat rooms (checklist #27 / #28): organisation-wide, department, team,
// private (two or more people) and custom rooms.

import { getMemberships, managedTeamIds, roleIn, userUnits, SUPER_ROLES } from "@/lib/permissions";

export type Room = {
  id: string;
  desk_id: string;
  name: string;
  kind: "org" | "department" | "team" | "private" | "custom";
  department_id: string | null;
  team_id: string | null;
  created_by: string | null;
};

// When each desk's default rooms were last checked (per server instance).
const lastEnsured = new Map<string, number>();

/**
 * Make sure the org room and a room for each team/department exist. Checked
 * at most once a minute per desk (pass `force` right after creating a team or
 * department). The database function does it in one step and can see every
 * room; the fallback below is for a database without it.
 */
export async function ensureDefaultRooms(supabase: any, deskId: string, force = false) {
  const now = Date.now();
  if (!force && now - (lastEnsured.get(deskId) || 0) < 60000) return;
  lastEnsured.set(deskId, now);

  const { error: rpcError } = await supabase.rpc("bb_ensure_default_rooms", { p_desk: deskId });
  if (!rpcError) return;

  const [{ data: rooms }, { data: teams }, { data: depts }] = await Promise.all([
    supabase.from("chat_rooms").select("id, kind, team_id, department_id, name").eq("desk_id", deskId),
    supabase.from("teams").select("id, name").eq("desk_id", deskId),
    supabase.from("departments").select("id, name").eq("desk_id", deskId),
  ]);
  const have = rooms || [];
  const missing: any[] = [];
  if (!have.some((r: any) => r.kind === "org")) missing.push({ desk_id: deskId, name: "general", kind: "org" });
  (teams || []).forEach((t: any) => {
    if (!have.some((r: any) => r.kind === "team" && r.team_id === t.id)) {
      missing.push({ desk_id: deskId, name: t.name, kind: "team", team_id: t.id });
    }
  });
  (depts || []).forEach((d: any) => {
    if (!have.some((r: any) => r.kind === "department" && r.department_id === d.id)) {
      missing.push({ desk_id: deskId, name: d.name, kind: "department", department_id: d.id });
    }
  });
  // One at a time: if two people open chat at the same moment, the database
  // keeps a single room per team/department and the second insert just fails.
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

  const [{ data: rooms }, { data: mine }, units, managed] = await Promise.all([
    supabase.from("chat_rooms").select("*").in("desk_id", deskIds).order("created_at"),
    supabase.from("chat_room_members").select("room_id").eq("user_id", userId),
    userUnits(supabase, userId),
    managedTeamIds(supabase, userId),
  ]);
  const memberOf = new Set((mine || []).map((m: any) => m.room_id));

  // Departments this person manages a team in also count.
  let managedDepts: string[] = [];
  if (managed.length) {
    const { data } = await supabase.from("teams").select("department_id").in("id", managed);
    managedDepts = (data || []).map((t: any) => t.department_id).filter(Boolean);
  }

  return (rooms || []).filter((r: any) => {
    const isSuper = SUPER_ROLES.includes(roleIn(memberships, r.desk_id));
    switch (r.kind) {
      case "org":
        return true;
      case "team":
        return isSuper || units.teamIds.includes(r.team_id) || managed.includes(r.team_id);
      case "department":
        return isSuper || units.departmentIds.includes(r.department_id) || managedDepts.includes(r.department_id);
      default:
        return memberOf.has(r.id) || r.created_by === userId;
    }
  });
}
