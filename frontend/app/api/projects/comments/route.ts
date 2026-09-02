import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";

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

    const { data, error } = await supabase
      .from("project_comments")
      .select("id, content, author_id, created_at")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true });

    if (error) throw error;
    return NextResponse.json({ comments: data || [], me: user.id });
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
    return NextResponse.json(data);
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
