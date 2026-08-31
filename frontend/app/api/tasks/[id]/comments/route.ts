// app/api/tasks/[id]/comments/route.ts

import { createServerSideClient } from "@/lib/supabase-server";
import { NextRequest, NextResponse } from "next/server";

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const { id: taskId } = params;

  try {
    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const { content } = body;

    if (!content || !content.trim()) return NextResponse.json({ error: "Content required" }, { status: 400 });

    const { data: comment, error } = await supabase
      .from("comments")
      .insert({
        task_id: taskId,
        author_id: user.id,
        content: content.trim(),
      })
      .select("id, content, author_id, created_at")
      .single();

    if (error) throw error;
    return NextResponse.json(comment);
  } catch (error: any) {
    console.error("POST /api/tasks/[id]/comments failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
