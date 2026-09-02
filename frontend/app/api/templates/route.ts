import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";

// SOW #11 / #12: reusable templates for repetitive work, including ones
// saved from a finished task.
async function deskFor(supabase: any, userId: string) {
  const { data } = await supabase
    .from("desk_members")
    .select("desk_id, project_id")
    .eq("user_id", userId)
    .limit(1)
    .single();
  return data?.desk_id ?? null;
}

export async function GET() {
  try {
    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const deskId = await deskFor(supabase, user.id);
    if (!deskId) return NextResponse.json({ templates: [] });

    const { data, error } = await supabase
      .from("task_templates")
      .select("id, name, title, description, priority, milestone, offset_days, created_at")
      .eq("desk_id", deskId)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return NextResponse.json({ templates: data || [] });
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
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const deskId = await deskFor(supabase, user.id);
    if (!deskId) return NextResponse.json({ error: "No desk found" }, { status: 400 });

    let source = {
      title: body.title,
      description: body.description ?? null,
      priority: body.priority ?? "medium",
      milestone: body.milestone ?? null,
    };

    // SOW #12: turn a completed task into a template.
    if (body.from_task_id) {
      const { data: task, error } = await supabase
        .from("tasks")
        .select("title, description, priority, milestone")
        .eq("id", body.from_task_id)
        .single();
      if (error || !task) {
        return NextResponse.json({ error: "Source task not found" }, { status: 404 });
      }
      source = {
        title: task.title,
        description: task.description,
        priority: task.priority,
        milestone: task.milestone,
      };
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
        offset_days: body.offset_days ?? 7,
        created_by: user.id,
      })
      .select("id, name, title, description, priority, milestone, offset_days, created_at")
      .single();

    if (error) throw error;
    return NextResponse.json(data);
  } catch (error: any) {
    console.error("POST /api/templates failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

// Create a real task from a template, dating it from today.
export async function PUT(req: Request) {
  try {
    const { template_id, project_id } = await req.json();
    if (!template_id) {
      return NextResponse.json({ error: "template_id required" }, { status: 400 });
    }

    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: tpl, error: tplError } = await supabase
      .from("task_templates")
      .select("title, description, priority, milestone, offset_days, desk_id")
      .eq("id", template_id)
      .single();

    if (tplError || !tpl) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    const { data: ctx } = await supabase
      .from("desk_members")
      .select("desk_id")
      .eq("user_id", user.id)
      .limit(1)
      .single();

    const { data: stage } = await supabase
      .from("stages")
      .select("id")
      .limit(1)
      .single();

    const { data: proj } = await supabase
      .from("projects")
      .select("id")
      .eq("desk_id", tpl.desk_id)
      .limit(1)
      .single();

    // SOW #12: dates are applied fresh rather than copied from the original.
    const due = new Date();
    due.setDate(due.getDate() + (tpl.offset_days ?? 7));

    const { data, error } = await supabase
      .from("tasks")
      .insert({
        desk_id: ctx?.desk_id ?? tpl.desk_id,
        project_id: project_id || proj?.id || null,
        stage_id: stage?.id ?? null,
        title: tpl.title,
        description: tpl.description,
        priority: tpl.priority,
        status: "pending",
        progress_percent: 0,
        due_date: due.toISOString(),
        milestone: tpl.milestone,
        created_by: user.id,
      })
      .select("id, title, description, priority, status, progress_percent, due_date, assigned_to, milestone, project_id, archived_at, team_id, task_manager_id, key_result_id, progress_type, progress_target, progress_current, created_by, created_at")
      .single();

    if (error) throw error;
    return NextResponse.json({ task: data });
  } catch (error: any) {
    console.error("PUT /api/templates failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
