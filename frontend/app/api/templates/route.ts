import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import { logActivity, requireUser, taskAccess } from "@/lib/permissions";
import { firstSection, sectionInProject } from "@/lib/workflow";

// SOW #11 / #12, checklist #12: reusable templates for repetitive work,
// including ones saved from a finished task. A template keeps the task's
// checklist, so "use the completed task as a template" brings the whole
// breakdown along and only small changes are needed.

type ChecklistItem = { title: string; progress_type?: string | null; progress_target?: number | null };

async function deskFor(supabase: any, userId: string) {
  const { data } = await supabase
    .from("desk_members")
    .select("desk_id")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();
  return data?.desk_id ?? null;
}

export async function GET() {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const deskId = await deskFor(supabase, user.id);
    if (!deskId) return NextResponse.json({ templates: [] });

    const { data, error } = await supabase
      .from("task_templates")
      .select("id, name, title, description, priority, milestone, offset_days, checklist, created_at")
      .eq("desk_id", deskId)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return NextResponse.json({
      templates: (data || []).map((t: any) => ({ ...t, checklist_count: Array.isArray(t.checklist) ? t.checklist.length : 0 })),
    });
  } catch (error: any) {
    console.error("GET /api/templates failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

// Save a template, either from scratch or from an existing task.
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const deskId = await deskFor(supabase, user.id);
    if (!deskId) return NextResponse.json({ error: "No desk found" }, { status: 400 });

    let source = {
      title: body.title,
      description: body.description ?? null,
      priority: body.priority ?? "medium",
      milestone: body.milestone ?? null,
    };
    let checklist: ChecklistItem[] = [];
    let offsetDays = body.offset_days ?? 7;

    // SOW #12: turn a (completed) task into a template.
    if (body.from_task_id) {
      const access = await taskAccess(supabase, user.id, body.from_task_id);
      if (!access?.canView) return NextResponse.json({ error: "Source task not found" }, { status: 404 });
      const task = access.task;
      source = { title: task.title, description: task.description, priority: task.priority, milestone: task.milestone };
      const { data: items } = await supabase
        .from("subtasks")
        .select("title, position, progress_type, progress_target")
        .eq("task_id", task.id)
        .order("position", { ascending: true });
      checklist = (items || []).map((i: any) => ({ title: i.title, progress_type: i.progress_type, progress_target: i.progress_target }));
      // Keep the same amount of time the original was given, if it had a start.
      if (body.offset_days === undefined && task.due_date) {
        const from = new Date(task.start_date || task.created_at).getTime();
        const days = Math.round((new Date(task.due_date).getTime() - from) / 86400000);
        if (days >= 1 && days <= 365) offsetDays = days;
      }
    }

    if (!source.title) {
      return NextResponse.json({ error: "A title is required" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("task_templates")
      .insert({
        desk_id: deskId,
        name: body.name?.trim() || source.title,
        title: source.title,
        description: source.description,
        priority: source.priority,
        milestone: source.milestone,
        offset_days: offsetDays,
        checklist: checklist.length ? checklist : null,
        created_by: user.id,
      })
      .select("id, name, title, description, priority, milestone, offset_days, checklist, created_at")
      .single();

    if (error) throw error;
    return NextResponse.json({ ...data, checklist_count: checklist.length });
  } catch (error: any) {
    console.error("POST /api/templates failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

// Create a real task from a template, dating it from today.
export async function PUT(req: Request) {
  try {
    const { template_id, project_id, stage_id } = await req.json();
    if (!template_id) {
      return NextResponse.json({ error: "template_id required" }, { status: 400 });
    }

    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: tpl, error: tplError } = await supabase
      .from("task_templates")
      .select("name, title, description, priority, milestone, offset_days, desk_id, checklist")
      .eq("id", template_id)
      .maybeSingle();

    if (tplError || !tpl) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    const deskId = await deskFor(supabase, user.id);
    if (!deskId || deskId !== tpl.desk_id) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    // Use the chosen project if it is on this desk, otherwise the first one.
    let proj: any = null;
    if (project_id) {
      const { data } = await supabase.from("projects").select("id, desk_id").eq("id", project_id).maybeSingle();
      if (data && data.desk_id === tpl.desk_id) proj = data;
    }
    if (!proj) {
      const { data } = await supabase.from("projects").select("id").eq("desk_id", tpl.desk_id)
        .order("created_at", { ascending: true }).limit(1).maybeSingle();
      proj = data;
    }
    if (!proj) return NextResponse.json({ error: "Create a project first" }, { status: 400 });

    let section: string | null = null;
    if (stage_id && (await sectionInProject(supabase, stage_id, proj.id))) section = stage_id;
    if (!section) section = await firstSection(supabase, proj.id);

    // SOW #12: dates are applied fresh rather than copied from the original.
    const due = new Date();
    due.setDate(due.getDate() + (tpl.offset_days ?? 7));

    const { data, error } = await supabase
      .from("tasks")
      .insert({
        desk_id: tpl.desk_id,
        project_id: proj.id,
        stage_id: section,
        title: tpl.title,
        description: tpl.description,
        priority: tpl.priority,
        status: "pending",
        progress_percent: 0,
        due_date: due.toISOString(),
        milestone: tpl.milestone,
        created_by: user.id,
      })
      .select("*")
      .single();

    if (error) throw error;

    const checklist: ChecklistItem[] = Array.isArray(tpl.checklist) ? tpl.checklist : [];
    if (checklist.length) {
      await supabase.from("subtasks").insert(
        checklist.map((item, i) => ({
          task_id: data.id,
          title: item.title,
          position: i,
          progress_type: item.progress_type || "percent",
          progress_target: item.progress_target ?? null,
          created_by: user.id,
        }))
      );
    }

    await logActivity(supabase, {
      entity_type: "task",
      entity_id: data.id,
      action: `created the task from the template "${tpl.name || tpl.title}"`,
      performed_by: user.id,
      desk_id: tpl.desk_id,
    });

    return NextResponse.json({ task: { ...data, subtask_count: checklist.length, for_me: false } });
  } catch (error: any) {
    console.error("PUT /api/templates failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
