// Checklist #32 / #33: files up to 25 MB go straight from the browser to
// storage. Vercel caps a request through the app at 4.5 MB, so the app only
// hands out a one-time upload link here (after checking the person works on
// the task) and records the file afterwards (POST ../attachments).

import { randomUUID } from "node:crypto";
import { createServerSideClient } from "@/lib/supabase-server";
import { NextRequest, NextResponse } from "next/server";
import { deny, requireUser, taskAccess } from "@/lib/permissions";
import { BUCKET, MAX_FILE_BYTES, safeFileName } from "@/lib/files";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: taskId } = await params;
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const access = await taskAccess(supabase, user.id, taskId);
    if (!access) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    if (!access.canWork) return deny("Only people working on this task can attach files.");

    const { file_name, file_size } = await request.json();
    if (!file_name) return NextResponse.json({ error: "file_name required" }, { status: 400 });
    if (Number(file_size) > MAX_FILE_BYTES) return NextResponse.json({ error: "File is larger than 25 MB" }, { status: 400 });

    const path = `${taskId}/${randomUUID()}-${safeFileName(String(file_name))}`;
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error || !data) throw error || new Error("Could not start the upload");

    return NextResponse.json({ path: data.path, token: data.token });
  } catch (error: any) {
    console.error("POST /api/tasks/[id]/attachments/upload failed:", error);
    return NextResponse.json({ error: error?.message || "Could not start the upload" }, { status: 500 });
  }
}
