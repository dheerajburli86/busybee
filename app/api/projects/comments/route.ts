import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import { getMemberships, logActivity } from "@/lib/permissions";
import { attachNames } from "@/lib/names";

async function projectOnMyDesk(supabase: any, userId: string, projectId: string) {
  const { data } = await supabase.from("projects").select("id, desk_id").eq("id", projectId).maybeSingle();
  if (!data) return null;
  const m = await getMemberships(supabase, userId);
  return m.some((x) => x.desk_id === data.desk_id) ? data : null;
}

// SOW #3: a project carries its own description and comment trail, separate
// from the comments on individual tasks.
export async function GET(req: Request) {
  try {
    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const url = new URL(req.url);
    const projectId = url.searchParams.get("project_id");
    if (!projectId) {
      return NextResponse.json({ error: "project_id required" }, { status: 400 });
    }

    if (!(await projectOnMyDesk(supabase, user.id, projectId))) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const { data, error } = await supabase
      .from("project_comments")
      .select("id, content, author_id, created_at")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true });

    if (error) throw error;
    return NextResponse.json({ comments: await attachNames(supabase, data || [], "author_id", "author_name"), me: user.id });
  } catch (error: any) {
    console.error("GET project comments failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { project_id, content } = await req.json();
    if (!project_id) {
      return NextResponse.json({ error: "project_id required" }, { status: 400 });
    }
    if (!content || !content.trim()) {
      return NextResponse.json({ error: "Comment is empty" }, { status: 400 });
    }

    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const project = await projectOnMyDesk(supabase, user.id, project_id);
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    const { data, error } = await supabase
      .from("project_comments")
      .insert({
        project_id,
        author_id: user.id,
        content: content.trim(),
      })
      .select("id, content, author_id, created_at")
      .single();

    if (error) throw error;
    await logActivity(supabase, {
      entity_type: "project", entity_id: project_id, action: "commented on the project",
      performed_by: user.id, desk_id: project.desk_id, changes: { comment: content.trim().slice(0, 200) },
    });
    const [named] = await attachNames(supabase, [data], "author_id", "author_name");
    return NextResponse.json(named);
  } catch (error: any) {
    console.error("POST project comments failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { comment_id } = await req.json();
    if (!comment_id) {
      return NextResponse.json({ error: "comment_id required" }, { status: 400 });
    }

    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Only the author can remove their own comment.
    const { error } = await supabase
      .from("project_comments")
      .delete()
      .eq("id", comment_id)
      .eq("author_id", user.id);

    if (error) throw error;
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("DELETE project comments failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
