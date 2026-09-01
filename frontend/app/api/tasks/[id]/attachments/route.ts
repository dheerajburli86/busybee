// app/api/tasks/[id]/attachments/route.ts

import { createServerSideClient } from "@/lib/supabase-server";
import { NextRequest, NextResponse } from "next/server";

const BUCKET = "task-files";

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
      .from("attachments")
      .select("id, file_name, file_url, file_type, file_size, visibility, uploaded_by, created_at")
      .eq("task_id", taskId)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return NextResponse.json(data || []);
  } catch (error: any) {
    console.error("GET /api/tasks/[id]/attachments failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const form = await request.formData();
    const file = form.get("file");

    if (!file || typeof file === "string") {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const blob = file as File;

    // 25 MB ceiling so a stray upload can't fill the bucket.
    if (blob.size > 25 * 1024 * 1024) {
      return NextResponse.json(
        { error: "File is larger than 25 MB" },
        { status: 400 }
      );
    }

    const safeName = blob.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `${taskId}/${Date.now()}-${safeName}`;

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(path, blob, {
        contentType: blob.type || "application/octet-stream",
        upsert: false,
      });

    if (uploadError) throw uploadError;

    const {
      data: { publicUrl },
    } = supabase.storage.from(BUCKET).getPublicUrl(path);

    const { data: attachment, error } = await supabase
      .from("attachments")
      .insert({
        task_id: taskId,
        file_name: blob.name,
        file_url: publicUrl,
        file_type: blob.type || null,
        file_size: blob.size,
        uploaded_by: user.id,
      })
      .select("id, file_name, file_url, file_type, file_size, visibility, uploaded_by, created_at")
      .single();

    if (error) throw error;

    await supabase.from("activity_log").insert({
      entity_type: "task",
      entity_id: taskId,
      action: "attached " + blob.name,
      performed_by: user.id,
      changes: { file: blob.name },
    }).then(() => {}, () => {});

    return NextResponse.json(attachment);
  } catch (error: any) {
    console.error("POST /api/tasks/[id]/attachments failed:", error);
    return NextResponse.json(
      { error: error?.message || "Upload failed" },
      { status: 500 }
    );
  }
}
