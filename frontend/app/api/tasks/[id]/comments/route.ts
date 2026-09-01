// app/api/tasks/[id]/comments/route.ts

import { createServerSideClient } from "@/lib/supabase-server";
import { NextRequest, NextResponse } from "next/server";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

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

    // @mention notifications. Match @name against desk teammates by full_name/email.
    const mentions: string[] = Array.from(
      new Set<string>(
        ((content.match(/@[A-Za-z0-9._-]+/g) || []) as string[]).map((m) => m.slice(1).toLowerCase())
      )
    );

    if (mentions.length > 0) {
      const { data: memberships } = await supabase
        .from("desk_members")
        .select("desk_id")
        .eq("user_id", user.id);
      const deskIds = (memberships || []).map((m: any) => m.desk_id);

      if (deskIds.length > 0) {
        const { data: mates } = await supabase
          .from("desk_members")
          .select("user_id, users(id, email, full_name)")
          .in("desk_id", deskIds);

        const seen = new Set<string>();
        for (const dm of mates || []) {
          const u: any = (dm as any).users;
          if (!u) continue;
          const handles = [
            (u.full_name || "").toLowerCase().replace(/\s+/g, ""),
            (u.email || "").split("@")[0].toLowerCase(),
          ].filter(Boolean);
          const hit = mentions.some((m: string) => handles.includes(m));
          if (!hit || seen.has(u.id) || u.id === user.id) continue;
          seen.add(u.id);
          await supabase.from("notifications").insert({
            user_id: u.id,
            task_id: taskId,
            type: "mention",
            title: "You were mentioned",
            message: content.trim().slice(0, 140),
            read: false,
          }).then(() => {}, () => {});
        }
      }
    }

    return NextResponse.json(comment);
  } catch (error: any) {
    console.error("POST /api/tasks/[id]/comments failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data, error } = await supabase
      .from("comments")
      .select("id, content, author_id, created_at")
      .eq("task_id", taskId)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return NextResponse.json(data || []);
  } catch (error: any) {
    console.error("GET /api/tasks/[id]/comments failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
