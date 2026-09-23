// Teams and groups. A team is a standing group of people, usually inside a
// department and run by a manager; a group (kind = 'group') is the ad-hoc
// version, put together for one piece of work. Both exist so a task can be
// handed to a set of people rather than one named person.
//
//   GET    /api/teams[?kind=team|group]   the desk's teams, with their people
//   POST   { name, kind?, department_id?, manager_id?, member_ids? }
//   PUT    { id, name?, kind?, department_id?, manager_id?, member_ids? }
//   DELETE { id }
//
// Anyone on the desk can read them. A supervisor/admin creates, edits and
// removes them; a team's own manager may edit the team they run.

import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import { deny, getMemberships, logActivity, requireUser, roleIn, SUPER_ROLES } from "@/lib/permissions";
import { inChunks, selectAll } from "@/lib/chunks";

const KINDS = ["team", "group"];
const MAX_NAME = 60;

/** One team, but only if it sits on a desk this person is on. */
async function deskTeam(supabase: any, deskIds: string[], id: any) {
  if (!id || deskIds.length === 0) return null;
  const { data } = await supabase.from("teams").select("*").eq("id", id).in("desk_id", deskIds).maybeSingle();
  return data || null;
}

/** The other teams on a desk - for the case-insensitive name check. */
async function otherNames(supabase: any, deskId: string, exceptId?: string): Promise<string[]> {
  const rows = await selectAll<any>(() =>
    supabase.from("teams").select("id, name").eq("desk_id", deskId).order("id")
  );
  return rows.filter((t: any) => t.id !== exceptId).map((t: any) => String(t.name || ""));
}

/**
 * Everything a team points at has to live on the same desk, so nobody can
 * borrow another desk's department, manager or people. Returns a message for
 * the first thing that doesn't, or null.
 */
async function offDesk(
  supabase: any,
  deskId: string,
  refs: { department_id?: any; manager_id?: any; member_ids?: any }
): Promise<string | null> {
  if (refs.department_id) {
    const { data } = await supabase
      .from("departments")
      .select("id")
      .eq("id", refs.department_id)
      .eq("desk_id", deskId)
      .limit(1);
    if (!data || data.length === 0) return "That department isn't on this desk";
  }
  if (refs.manager_id) {
    const { data } = await supabase
      .from("desk_members")
      .select("user_id")
      .eq("desk_id", deskId)
      .eq("user_id", refs.manager_id)
      .limit(1);
    if (!data || data.length === 0) return "That manager isn't on this desk";
  }
  if (Array.isArray(refs.member_ids) && refs.member_ids.length > 0) {
    const ids = Array.from(new Set(refs.member_ids.filter(Boolean))) as string[];
    const rows = await inChunks<any>(
      ids,
      (part) => supabase.from("desk_members").select("user_id").eq("desk_id", deskId).in("user_id", part).order("user_id"),
      { all: true }
    );
    const onDesk = new Set((rows || []).map((r: any) => r.user_id));
    if (ids.some((uid) => !onDesk.has(uid))) return "Everyone on a team has to be on this desk";
  }
  return null;
}

/** Fill in each team's people, its department's name and its manager's name. */
async function decorate(supabase: any, teams: any[]): Promise<any[]> {
  if (teams.length === 0) return [];

  // team_members.user_id carries no foreign key to users, so a PostgREST
  // embed - `users(...)` inside the select - is rejected with PGRST200
  // ("Could not find a relationship") and would take the whole request down.
  // The people are looked up in a second query instead, the way the rest of
  // the app resolves names (see lib/names.ts, attachNames). This works
  // whether or not the foreign key is ever added.
  const [rows, departments] = await Promise.all([
    inChunks<any>(
      teams.map((t: any) => t.id),
      (part) => supabase.from("team_members").select("id, team_id, user_id").in("team_id", part).order("id"),
      { all: true }
    ),
    inChunks<any>(
      teams.map((t: any) => t.department_id).filter(Boolean),
      (part) => supabase.from("departments").select("id, name").in("id", part).order("id")
    ),
  ]);

  // One lookup for everyone named here: the members and the managers.
  const people = await inChunks<any>(
    [...(rows || []).map((r: any) => r.user_id), ...teams.map((t: any) => t.manager_id)].filter(Boolean),
    (part) => supabase.from("users").select("id, email, full_name").in("id", part).order("id")
  );
  const byUser = new Map<string, any>((people || []).map((u: any) => [u.id, u]));

  const byTeam = new Map<string, any[]>();
  (rows || []).forEach((r: any) => {
    // The proper name; the email is only a fallback for a profile with no
    // name set.
    const u = byUser.get(r.user_id);
    const person = { id: r.user_id, name: u?.full_name || u?.email || "Someone", email: u?.email || null };
    byTeam.set(r.team_id, [...(byTeam.get(r.team_id) || []), person]);
  });
  const deptName = new Map<string, string>((departments || []).map((d: any) => [d.id, d.name]));
  const managerName = new Map<string, string>(
    (people || []).map((u: any) => [u.id, u.full_name || u.email || "Someone"])
  );

  return teams.map((t: any) => {
    const members = (byTeam.get(t.id) || []).sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
    return {
      ...t,
      members,
      member_count: members.length,
      department_name: t.department_id ? deptName.get(t.department_id) || null : null,
      manager_name: t.manager_id ? managerName.get(t.manager_id) || null : null,
    };
  });
}

/**
 * decorate() for a row that has just been written. The write has already
 * committed by this point, so a failure while dressing the answer up must not
 * turn a successful create/edit into a 500 - the caller would see an error for
 * a team that does exist, and a retry would then be refused as a duplicate
 * name. Whatever could be worked out is returned; at worst the row itself.
 */
async function decorateSafely(supabase: any, team: any): Promise<any> {
  try {
    const [out] = await decorate(supabase, [team]);
    if (out) return out;
  } catch (error: any) {
    console.error("Decorating a team failed:", error);
  }
  return {
    ...team,
    members: [],
    member_count: 0,
    department_name: null,
    manager_name: null,
  };
}

/** The desk+name unique index firing means the name is taken - a 400, not a 500. */
function nameTaken(error: any) {
  return error?.code === "23505";
}

export async function GET(req: Request) {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const kind = new URL(req.url).searchParams.get("kind");
    if (kind && !KINDS.includes(kind)) {
      return NextResponse.json({ error: `kind must be one of: ${KINDS.join(", ")}` }, { status: 400 });
    }

    const memberships = await getMemberships(supabase, user.id);
    const deskIds = memberships.map((m) => m.desk_id);
    if (deskIds.length === 0) return NextResponse.json({ teams: [] });

    const found = await selectAll<any>(() => {
      const q = supabase.from("teams").select("*").in("desk_id", deskIds);
      return (kind ? q.eq("kind", kind) : q).order("name").order("id");
    });

    const teams = await decorate(supabase, found);
    return NextResponse.json({
      teams: teams.map((t: any) => ({
        ...t,
        can_manage: SUPER_ROLES.includes(roleIn(memberships, t.desk_id)) || t.manager_id === user.id,
      })),
    });
  } catch (error: any) {
    console.error("GET /api/teams failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

// Create a team or a group (supervisor/admin only).
export async function POST(req: Request) {
  try {
    const { name, kind = "team", department_id, manager_id, member_ids } = await req.json();
    const clean = String(name || "").trim().slice(0, MAX_NAME);
    if (!clean) return NextResponse.json({ error: "Give the team a name" }, { status: 400 });
    if (!KINDS.includes(kind)) {
      return NextResponse.json({ error: `kind must be one of: ${KINDS.join(", ")}` }, { status: 400 });
    }
    if (member_ids !== undefined && !Array.isArray(member_ids)) {
      return NextResponse.json({ error: "member_ids must be a list of people" }, { status: 400 });
    }

    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const memberships = await getMemberships(supabase, user.id);
    const deskId = memberships[0]?.desk_id;
    if (!deskId) return NextResponse.json({ error: "No desk found" }, { status: 400 });
    if (!SUPER_ROLES.includes(roleIn(memberships, deskId))) {
      return deny("Only a supervisor or admin can create teams.");
    }

    const taken = await otherNames(supabase, deskId);
    if (taken.some((n) => n.toLowerCase() === clean.toLowerCase())) {
      return NextResponse.json({ error: "This desk already has a team with that name" }, { status: 400 });
    }
    const wrongDesk = await offDesk(supabase, deskId, { department_id, manager_id, member_ids });
    if (wrongDesk) return NextResponse.json({ error: wrongDesk }, { status: 400 });

    const { data: team, error } = await supabase
      .from("teams")
      .insert({
        desk_id: deskId,
        name: clean,
        kind,
        department_id: department_id || null,
        manager_id: manager_id || null,
        created_by: user.id,
      })
      .select("*")
      .single();
    if (error) {
      // The name check above is check-then-act and can race (two tabs, a
      // retry). The desk+name unique index is the real guard.
      if (nameTaken(error)) {
        return NextResponse.json({ error: "This desk already has a team with that name" }, { status: 400 });
      }
      throw error;
    }

    const ids = Array.from(new Set((member_ids || []).filter(Boolean))) as string[];
    if (ids.length > 0) {
      const { error: addError } = await supabase
        .from("team_members")
        .insert(ids.map((uid) => ({ team_id: team.id, user_id: uid })));
      // Put the half-made team back if its people couldn't be added, so a
      // failed create doesn't leave a ghost team sitting on the name.
      if (addError) {
        await supabase.from("teams").delete().eq("id", team.id).eq("desk_id", deskId);
        throw addError;
      }
    }

    await logActivity(supabase, {
      entity_type: "desk", entity_id: deskId, action: `created ${kind} "${clean}"`,
      performed_by: user.id, desk_id: deskId,
      changes: { team_id: team.id, kind, department_id: department_id || null, manager_id: manager_id || null, member_ids: ids },
    });

    const out = await decorateSafely(supabase, team);
    return NextResponse.json({ ...out, can_manage: true });
  } catch (error: any) {
    console.error("POST /api/teams failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

// Edit a team: its name, kind, department, manager, and/or who is on it.
// A supervisor/admin may edit any of them; the team's own manager may edit
// the team they run.
export async function PUT(req: Request) {
  try {
    const body = await req.json();
    if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
    if (body.member_ids !== undefined && !Array.isArray(body.member_ids)) {
      return NextResponse.json({ error: "member_ids must be a list of people" }, { status: 400 });
    }

    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const memberships = await getMemberships(supabase, user.id);
    const deskIds = memberships.map((m) => m.desk_id);
    const team = await deskTeam(supabase, deskIds, body.id);
    if (!team) return NextResponse.json({ error: "Team not found" }, { status: 404 });
    const isSuper = SUPER_ROLES.includes(roleIn(memberships, team.desk_id));
    if (!isSuper && team.manager_id !== user.id) {
      return deny("Only a supervisor or the team's manager can edit it.");
    }

    const patch: Record<string, any> = {};
    if (body.name !== undefined) {
      const clean = String(body.name || "").trim().slice(0, MAX_NAME);
      if (!clean) return NextResponse.json({ error: "Give the team a name" }, { status: 400 });
      const taken = await otherNames(supabase, team.desk_id, team.id);
      if (taken.some((n) => n.toLowerCase() === clean.toLowerCase())) {
        return NextResponse.json({ error: "This desk already has a team with that name" }, { status: 400 });
      }
      patch.name = clean;
    }
    if (body.kind !== undefined) {
      if (!KINDS.includes(body.kind)) {
        return NextResponse.json({ error: `kind must be one of: ${KINDS.join(", ")}` }, { status: 400 });
      }
      patch.kind = body.kind;
    }
    if ("department_id" in body) patch.department_id = body.department_id || null;
    // Same rule as a project's manager (#22): only a supervisor/admin names or
    // changes one. Otherwise a team's manager could hand the team to someone
    // else, or lock themselves out of it. Sending back the manager the team
    // already has is not a change, so the manager can still edit everything
    // else with the whole team in the body.
    if ("manager_id" in body) {
      const next = body.manager_id || null;
      if (next !== (team.manager_id || null)) {
        if (!isSuper) return deny("Only a supervisor or admin can change a team's manager.");
        patch.manager_id = next;
      }
    }

    const replacing = Array.isArray(body.member_ids);
    if (Object.keys(patch).length === 0 && !replacing) {
      return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
    }

    const wrongDesk = await offDesk(supabase, team.desk_id, {
      department_id: patch.department_id,
      manager_id: patch.manager_id,
      member_ids: replacing ? body.member_ids : undefined,
    });
    if (wrongDesk) return NextResponse.json({ error: wrongDesk }, { status: 400 });

    if (Object.keys(patch).length > 0) {
      const { error } = await supabase
        .from("teams")
        .update(patch)
        .eq("id", team.id)
        .eq("desk_id", team.desk_id);
      if (error) {
        if (nameTaken(error)) {
          return NextResponse.json({ error: "This desk already has a team with that name" }, { status: 400 });
        }
        throw error;
      }
    }

    // member_ids replaces the whole membership rather than adding to it, so
    // the caller sends the list they want and gets exactly that. There is no
    // transaction here, so the new people go in BEFORE the old ones come out:
    // an insert that fails leaves the team with the membership it had, where
    // deleting first would have left it empty.
    let ids: string[] = [];
    if (replacing) {
      ids = Array.from(new Set(body.member_ids.filter(Boolean))) as string[];
      const current = await selectAll<any>(() =>
        supabase.from("team_members").select("id, user_id").eq("team_id", team.id).order("id")
      );
      const already = new Set((current || []).map((r: any) => r.user_id));
      const adding = ids.filter((uid) => !already.has(uid));
      if (adding.length > 0) {
        const { error: addError } = await supabase
          .from("team_members")
          .insert(adding.map((uid) => ({ team_id: team.id, user_id: uid })));
        if (addError) throw addError;
      }
      const keep = new Set(ids);
      const dropping = (current || []).filter((r: any) => !keep.has(r.user_id)).map((r: any) => r.id);
      if (dropping.length > 0) {
        await inChunks<any>(dropping, (part) =>
          supabase.from("team_members").delete().in("id", part).select("id")
        );
      }
    }

    await logActivity(supabase, {
      entity_type: "desk", entity_id: team.desk_id,
      action:
        replacing && Object.keys(patch).length === 0
          ? `changed who is on ${team.kind} "${team.name}"`
          : `edited ${team.kind} "${team.name}"`,
      performed_by: user.id, desk_id: team.desk_id,
      changes: replacing ? { team_id: team.id, ...patch, member_ids: ids } : { team_id: team.id, ...patch },
    });

    const { data: updated } = await supabase.from("teams").select("*").eq("id", team.id).maybeSingle();
    const out = await decorateSafely(supabase, updated || { ...team, ...patch });
    return NextResponse.json({ ...out, can_manage: true });
  } catch (error: any) {
    console.error("PUT /api/teams failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

// Remove a team or group (supervisor/admin only). Its membership rows go with
// it; the people themselves stay on the desk.
export async function DELETE(req: Request) {
  try {
    const { id } = await req.json();
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const memberships = await getMemberships(supabase, user.id);
    const deskIds = memberships.map((m) => m.desk_id);
    const team = await deskTeam(supabase, deskIds, id);
    if (!team) return NextResponse.json({ error: "Team not found" }, { status: 404 });
    if (!SUPER_ROLES.includes(roleIn(memberships, team.desk_id))) {
      return deny("Only a supervisor or admin can remove a team.");
    }

    const { error: membersError } = await supabase.from("team_members").delete().eq("team_id", team.id);
    if (membersError) throw membersError;

    const { error } = await supabase.from("teams").delete().eq("id", team.id).eq("desk_id", team.desk_id);
    if (error) throw error;

    await logActivity(supabase, {
      entity_type: "desk", entity_id: team.desk_id, action: `removed ${team.kind} "${team.name}"`,
      performed_by: user.id, desk_id: team.desk_id, changes: { team_id: team.id },
    });
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("DELETE /api/teams failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
