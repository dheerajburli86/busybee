// Checklist #20: a project's sections (e.g. Design, Development, Writing).
//
//   GET    /api/sections?project_id=     the project's sections, in order
//   POST   { project_id, name }          add a section at the end
//   PUT    { id, name }                  rename
//   PUT    { project_id, order: [ids] }  reorder
//   DELETE { id, move_to? }              remove; its tasks move to `move_to`
//                                        (default: the first other section)
//
// Anyone on the desk can read them; the project's managers (a supervisor, or
// the project's manager) change them.

import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import { deny, logActivity, projectAccess, requireUser } from "@/lib/permissions";
import { sectionsOf } from "@/lib/workflow";

const MAX_NAME = 60;

async function access(supabase: any, userId: string, projectId: string | null | undefined) {
  if (!projectId) return null;
  return projectAccess(supabase, userId, projectId);
}

export async function GET(req: Request) {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const projectId = new URL(req.url).searchParams.get("project_id");
    const a = await access(supabase, user.id, projectId);
    if (!a) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    return NextResponse.json({ sections: await sectionsOf(supabase, a.project.id), can_manage: a.canManage });
  } catch (error: any) {
    console.error("GET /api/sections failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { project_id, name } = await req.json();
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const a = await access(supabase, user.id, project_id);
    if (!a) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    if (!a.canManage) return deny("Only a supervisor or the project's manager can change its sections.");

    const clean = String(name || "").trim().slice(0, MAX_NAME);
    if (!clean) return NextResponse.json({ error: "Give the section a name" }, { status: 400 });

    const existing = await sectionsOf(supabase, a.project.id);
    if (existing.some((s) => s.name.toLowerCase() === clean.toLowerCase())) {
      return NextResponse.json({ error: "This project already has a section with that name" }, { status: 400 });
    }
    const position = existing.length ? Math.max(...existing.map((s) => s.position)) + 1 : 0;

    const { data, error } = await supabase
      .from("stages")
      .insert({ project_id: a.project.id, name: clean, position })
      .select("id, project_id, name, position")
      .single();
    if (error) throw error;

    await logActivity(supabase, {
      entity_type: "project", entity_id: a.project.id, action: `added section "${clean}"`,
      performed_by: user.id, desk_id: a.project.desk_id,
    });
    return NextResponse.json(data);
  } catch (error: any) {
    console.error("POST /api/sections failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const body = await req.json();
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Reorder the whole list.
    if (Array.isArray(body.order)) {
      const a = await access(supabase, user.id, body.project_id);
      if (!a) return NextResponse.json({ error: "Project not found" }, { status: 404 });
      if (!a.canManage) return deny("Only a supervisor or the project's manager can change its sections.");
      const existing = await sectionsOf(supabase, a.project.id);
      const order: string[] = body.order;
      const same = order.length === existing.length && existing.every((s) => order.includes(s.id));
      if (!same) return NextResponse.json({ error: "The order must list every section of the project once" }, { status: 400 });
      for (let i = 0; i < order.length; i++) {
        const { error } = await supabase.from("stages").update({ position: i }).eq("id", order[i]);
        if (error) throw error;
      }
      await logActivity(supabase, {
        entity_type: "project", entity_id: a.project.id, action: "reordered the sections",
        performed_by: user.id, desk_id: a.project.desk_id,
      });
      return NextResponse.json({ sections: await sectionsOf(supabase, a.project.id) });
    }

    // Rename one.
    const { data: stage } = await supabase.from("stages").select("id, project_id, name").eq("id", body.id).maybeSingle();
    if (!stage) return NextResponse.json({ error: "Section not found" }, { status: 404 });
    const a = await access(supabase, user.id, stage.project_id);
    if (!a) return NextResponse.json({ error: "Section not found" }, { status: 404 });
    if (!a.canManage) return deny("Only a supervisor or the project's manager can change its sections.");

    const clean = String(body.name || "").trim().slice(0, MAX_NAME);
    if (!clean) return NextResponse.json({ error: "Give the section a name" }, { status: 400 });
    const others = (await sectionsOf(supabase, stage.project_id)).filter((s) => s.id !== stage.id);
    if (others.some((s) => s.name.toLowerCase() === clean.toLowerCase())) {
      return NextResponse.json({ error: "This project already has a section with that name" }, { status: 400 });
    }

    const { data, error } = await supabase.from("stages").update({ name: clean }).eq("id", stage.id).select("id, project_id, name, position").single();
    if (error) throw error;
    await logActivity(supabase, {
      entity_type: "project", entity_id: stage.project_id, action: `renamed section "${stage.name}" to "${clean}"`,
      performed_by: user.id, desk_id: a.project.desk_id,
    });
    return NextResponse.json(data);
  } catch (error: any) {
    console.error("PUT /api/sections failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { id, move_to } = await req.json();
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: stage } = await supabase.from("stages").select("id, project_id, name").eq("id", id).maybeSingle();
    if (!stage) return NextResponse.json({ error: "Section not found" }, { status: 404 });
    const a = await access(supabase, user.id, stage.project_id);
    if (!a) return NextResponse.json({ error: "Section not found" }, { status: 404 });
    if (!a.canManage) return deny("Only a supervisor or the project's manager can change its sections.");

    const others = (await sectionsOf(supabase, stage.project_id)).filter((s) => s.id !== stage.id);
    if (others.length === 0) return NextResponse.json({ error: "A project needs at least one section" }, { status: 400 });
    const target = move_to ? others.find((s) => s.id === move_to) : others[0];
    if (!target) return NextResponse.json({ error: "Pick another section of this project for its tasks" }, { status: 400 });

    // Moving the tasks (including people's private to-do items, which this
    // person can't see) and removing the section happen together in the
    // database, which re-checks that this person may do it.
    const { data: movedCount, error } = await supabase.rpc("bb_delete_section", { p_stage: stage.id, p_move_to: target.id });
    if (error) throw error;
    const moved = Number(movedCount) || 0;

    await logActivity(supabase, {
      entity_type: "project", entity_id: stage.project_id,
      action: `removed section "${stage.name}"${moved ? ` and moved its ${moved} task${moved === 1 ? "" : "s"} to "${target.name}"` : ""}`,
      performed_by: user.id, desk_id: a.project.desk_id,
    });
    return NextResponse.json({ ok: true, moved, moved_to: target.id });
  } catch (error: any) {
    console.error("DELETE /api/sections failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
