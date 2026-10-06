// Departments: the desk's org structure. A department holds people (via
// desk_members.department_id) and teams (via teams.department_id), so a task
// can be handed to a whole department instead of a named person.
//
//   GET    /api/departments              every department on the desk
//   POST   { name }                      add one
//   PUT    { id, name }                  rename one
//   PUT    { user_id, department_id }    put a person in a department (null clears)
//   DELETE { id }                        remove one
//
// Anyone on the desk can read them; only a supervisor/admin changes them.

import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import { deny, getMemberships, logActivity, requireUser, roleIn, SUPER_ROLES } from "@/lib/permissions";
import { inChunks, selectAll } from "@/lib/chunks";

const MAX_NAME = 60;

/** One department, but only if it sits on a desk this person is on. */
async function deskDepartment(supabase: any, deskIds: string[], id: any) {
  if (!id || deskIds.length === 0) return null;
  const { data } = await supabase
    .from("departments")
    .select("*")
    .eq("id", id)
    .in("desk_id", deskIds)
    .maybeSingle();
  return data || null;
}

/** The other departments on a desk - for the case-insensitive name check. */
async function otherNames(supabase: any, deskId: string, exceptId?: string): Promise<string[]> {
  const rows = await selectAll<any>(() =>
    supabase.from("departments").select("id, name").eq("desk_id", deskId).order("id")
  );
  return rows.filter((d: any) => d.id !== exceptId).map((d: any) => String(d.name || ""));
}

export async function GET() {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const memberships = await getMemberships(supabase, user.id);
    const deskIds = memberships.map((m) => m.desk_id);
    if (deskIds.length === 0) return NextResponse.json({ departments: [] });

    const departments = await selectAll<any>(() =>
      supabase.from("departments").select("*").in("desk_id", deskIds).order("name").order("id")
    );
    const ids = departments.map((d: any) => d.id);

    // How many people sit in each department, and how many teams belong to it.
    // Both counts stay inside the caller's desks.
    const [people, teams] = await Promise.all([
      inChunks<any>(
        ids,
        (part) =>
          supabase
            .from("desk_members")
            .select("user_id, department_id")
            .in("desk_id", deskIds)
            .in("department_id", part)
            .order("user_id"),
        { all: true }
      ),
      inChunks<any>(
        ids,
        (part) =>
          supabase
            .from("teams")
            .select("id, department_id")
            .in("desk_id", deskIds)
            .in("department_id", part)
            .order("id"),
        { all: true }
      ),
    ]);

    const memberCount = new Map<string, number>();
    people.forEach((p: any) => memberCount.set(p.department_id, (memberCount.get(p.department_id) || 0) + 1));
    const teamCount = new Map<string, number>();
    teams.forEach((t: any) => teamCount.set(t.department_id, (teamCount.get(t.department_id) || 0) + 1));

    return NextResponse.json({
      departments: departments.map((d: any) => ({
        ...d,
        member_count: memberCount.get(d.id) || 0,
        team_count: teamCount.get(d.id) || 0,
        can_manage: SUPER_ROLES.includes(roleIn(memberships, d.desk_id)),
      })),
    });
  } catch (error: any) {
    console.error("GET /api/departments failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

// Create a department (supervisor/admin only).
export async function POST(req: Request) {
  try {
    const { name } = await req.json();
    const clean = String(name || "").trim().slice(0, MAX_NAME);
    if (!clean) return NextResponse.json({ error: "Give the department a name" }, { status: 400 });

    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const memberships = await getMemberships(supabase, user.id);
    const deskId = memberships[0]?.desk_id;
    if (!deskId) return NextResponse.json({ error: "No desk found" }, { status: 400 });
    if (!SUPER_ROLES.includes(roleIn(memberships, deskId))) {
      return deny("Only a supervisor or admin can create departments.");
    }

    const taken = await otherNames(supabase, deskId);
    if (taken.some((n) => n.toLowerCase() === clean.toLowerCase())) {
      return NextResponse.json({ error: "This desk already has a department with that name" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("departments")
      .insert({ desk_id: deskId, name: clean, created_by: user.id })
      .select("*")
      .single();
    if (error) throw error;

    await logActivity(supabase, {
      entity_type: "desk", entity_id: deskId, action: `created department "${clean}"`,
      performed_by: user.id, desk_id: deskId, changes: { department_id: data.id, name: clean },
    });
    return NextResponse.json({ ...data, member_count: 0, team_count: 0, can_manage: true });
  } catch (error: any) {
    console.error("POST /api/departments failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

// Two jobs, told apart by the keys sent:
//   { user_id, department_id }  puts a person in a department (null clears it)
//   { id, name }                renames a department
// Both are supervisor/admin work.
export async function PUT(req: Request) {
  try {
    const body = await req.json();

    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const memberships = await getMemberships(supabase, user.id);
    const deskIds = memberships.map((m) => m.desk_id);
    if (deskIds.length === 0) return NextResponse.json({ error: "No desk found" }, { status: 400 });

    // Put a person in a department.
    if (body.user_id) {
      if (!("department_id" in body)) {
        return NextResponse.json({ error: "department_id required (send null to clear it)" }, { status: 400 });
      }

      // The person has to be on one of the caller's desks, and that desk is
      // the one this change happens on. Someone can share more than one desk
      // with the caller, so every shared desk is read - asking for a single
      // row here came back empty for exactly those people, and the answer was
      // wrongly "that person isn't on this desk".
      const { data: shared, error: sharedError } = await supabase
        .from("desk_members")
        .select("desk_id, user_id, department_id")
        .eq("user_id", body.user_id)
        .in("desk_id", deskIds);
      if (sharedError) throw sharedError;
      if (!shared || shared.length === 0) {
        return NextResponse.json({ error: "That person isn't on this desk" }, { status: 400 });
      }
      // Of those, the desks the caller actually runs.
      const mine = shared.filter((r: any) => SUPER_ROLES.includes(roleIn(memberships, r.desk_id)));
      if (mine.length === 0) {
        return deny("Only a supervisor or admin can put someone in a department.");
      }

      let row: any = null;
      let department: any = null;
      if (body.department_id) {
        // The department settles which desk this happens on: it has to be one
        // the caller runs, and the person has to be on it.
        department = await deskDepartment(supabase, mine.map((r: any) => r.desk_id), body.department_id);
        if (!department) {
          return NextResponse.json({ error: "That department isn't on this desk" }, { status: 400 });
        }
        row = mine.find((r: any) => r.desk_id === department.desk_id) || null;
        if (!row) return NextResponse.json({ error: "That person isn't on this desk" }, { status: 400 });
      } else if (body.desk_id) {
        // Clearing, with the desk named outright.
        row = mine.find((r: any) => r.desk_id === body.desk_id) || null;
        if (!row) return NextResponse.json({ error: "That person isn't on this desk" }, { status: 400 });
      } else {
        // Clearing without a desk: the only desk they're in a department on,
        // or the only desk at all. Anything else is genuinely ambiguous.
        const seated = mine.filter((r: any) => r.department_id);
        const choices = seated.length > 0 ? seated : mine;
        if (choices.length > 1) {
          return NextResponse.json(
            { error: "That person is on more than one of your desks - send desk_id to say which" },
            { status: 400 }
          );
        }
        row = choices[0];
      }

      const { error } = await supabase
        .from("desk_members")
        .update({ department_id: department ? department.id : null })
        .eq("desk_id", row.desk_id)
        .eq("user_id", body.user_id);
      if (error) throw error;

      await logActivity(supabase, {
        entity_type: "desk", entity_id: row.desk_id,
        action: department ? `moved someone into department "${department.name}"` : "took someone out of their department",
        performed_by: user.id, desk_id: row.desk_id,
        changes: { user_id: body.user_id, department_id: department ? department.id : null },
      });
      return NextResponse.json({ user_id: body.user_id, department_id: department ? department.id : null });
    }

    // Rename a department.
    if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const department = await deskDepartment(supabase, deskIds, body.id);
    if (!department) return NextResponse.json({ error: "Department not found" }, { status: 404 });
    if (!SUPER_ROLES.includes(roleIn(memberships, department.desk_id))) {
      return deny("Only a supervisor or admin can rename a department.");
    }

    const clean = String(body.name || "").trim().slice(0, MAX_NAME);
    if (!clean) return NextResponse.json({ error: "Give the department a name" }, { status: 400 });
    const taken = await otherNames(supabase, department.desk_id, department.id);
    if (taken.some((n) => n.toLowerCase() === clean.toLowerCase())) {
      return NextResponse.json({ error: "This desk already has a department with that name" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("departments")
      .update({ name: clean })
      .eq("id", department.id)
      .eq("desk_id", department.desk_id)
      .select("*")
      .single();
    if (error) throw error;

    await logActivity(supabase, {
      entity_type: "desk", entity_id: department.desk_id,
      action: `renamed department "${department.name}" to "${clean}"`,
      performed_by: user.id, desk_id: department.desk_id, changes: { department_id: department.id, name: clean },
    });
    return NextResponse.json({ ...data, can_manage: true });
  } catch (error: any) {
    console.error("PUT /api/departments failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

// Remove a department (supervisor/admin only). The people and teams in it stay
// put - they just stop belonging to a department. The foreign keys are ON
// DELETE SET NULL, but doing it here first keeps the answer predictable and
// lets us say how much was touched.
export async function DELETE(req: Request) {
  try {
    const { id } = await req.json();
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const memberships = await getMemberships(supabase, user.id);
    const deskIds = memberships.map((m) => m.desk_id);
    const department = await deskDepartment(supabase, deskIds, id);
    if (!department) return NextResponse.json({ error: "Department not found" }, { status: 404 });
    if (!SUPER_ROLES.includes(roleIn(memberships, department.desk_id))) {
      return deny("Only a supervisor or admin can remove a department.");
    }

    const { data: freedPeople, error: peopleError } = await supabase
      .from("desk_members")
      .update({ department_id: null })
      .eq("desk_id", department.desk_id)
      .eq("department_id", department.id)
      .select("user_id");
    if (peopleError) throw peopleError;

    const { data: freedTeams, error: teamsError } = await supabase
      .from("teams")
      .update({ department_id: null })
      .eq("desk_id", department.desk_id)
      .eq("department_id", department.id)
      .select("id");
    if (teamsError) throw teamsError;

    const { error } = await supabase
      .from("departments")
      .delete()
      .eq("id", department.id)
      .eq("desk_id", department.desk_id);
    if (error) throw error;

    const people = (freedPeople || []).length;
    const teams = (freedTeams || []).length;
    await logActivity(supabase, {
      entity_type: "desk", entity_id: department.desk_id,
      action: `removed department "${department.name}"`,
      performed_by: user.id, desk_id: department.desk_id,
      changes: { department_id: department.id, people_freed: people, teams_freed: teams },
    });
    return NextResponse.json({ ok: true, people_freed: people, teams_freed: teams });
  } catch (error: any) {
    console.error("DELETE /api/departments failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
