// app/api/tasks/[id]/attachments/route.ts
//
// Files on a task (checklist #32 / #33) with access control (checklist #47).
// Files live in a private bucket; the list never exposes storage URLs, only
// /api/attachments/<id>/download, which re-checks access and hands out a
// short-lived signed link.

import { createServerSideClient } from "@/lib/supabase-server";
import { NextRequest, NextResponse } from "next/server";
import { deny, getMemberships, logActivity, requireUser, taskAccess } from "@/lib/permissions";
import { BUCKET, MAX_FILE_BYTES, canOpen, extraAssignorIds, safeFileName, storagePathOf } from "@/lib/files";
import { attachNames } from "@/lib/names";

type Params = { params: Promise<{ id: string }> };
const VISIBILITIES = ["all", "restricted", "custom"];
const MAX_BYTES = MAX_FILE_BYTES;

async function sharedMap(supabase: any, ids: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (!ids.length) return map;
  const { data } = await supabase.from("attachment_access").select("attachment_id, user_id").in("attachment_id", ids);
  (data || []).forEach((r: any) => map.set(r.attachment_id, [...(map.get(r.attachment_id) || []), r.user_id]));
  return map;
}

function present(file: any, userId: string, access: any, shared: string[]) {
  const { storage_path, file_url, ...rest } = file;
  const mayManage = file.uploaded_by === userId || access.canManage;
  return {
    ...rest,
    visibility: file.visibility || "all",
    download_url: `/api/attachments/${file.id}/download`,
    can_manage: mayManage,
    shared_with: mayManage ? shared : undefined,
  };
}

async function setSharedWith(supabase: any, attachmentId: string, deskId: string, userIds: string[]) {
  await supabase.from("attachment_access").delete().eq("attachment_id", attachmentId);
  const valid: string[] = [];
  for (const uid of Array.from(new Set(userIds.filter(Boolean)))) {
    const m = await getMemberships(supabase, uid);
    if (m.some((x) => x.desk_id === deskId)) valid.push(uid);
  }
  if (valid.length) {
    await supabase.from("attachment_access").insert(valid.map((user_id) => ({ attachment_id: attachmentId, user_id })));
  }
  return valid;
}

export async function GET(_request: NextRequest, { params }: Params) {
  const { id: taskId } = await params;
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const access = await taskAccess(supabase, user.id, taskId);
    if (!access?.canView) return NextResponse.json({ error: "Task not found" }, { status: 404 });

    const { data, error } = await supabase
      .from("attachments")
      .select("*")
      .eq("task_id", taskId)
      .order("created_at", { ascending: false });
    if (error) throw error;

    const rows = data || [];
    const [extra, shared] = await Promise.all([
      extraAssignorIds(supabase, taskId),
      sharedMap(supabase, rows.map((r: any) => r.id)),
    ]);

    const allowed = rows
      .filter((f: any) => canOpen(f, user.id, access, extra, shared.get(f.id) || []))
      .map((f: any) => present(f, user.id, access, shared.get(f.id) || []));

    return NextResponse.json(await attachNames(supabase, allowed, "uploaded_by", "uploader_name"));
  } catch (error: any) {
    console.error("GET /api/tasks/[id]/attachments failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  const { id: taskId } = await params;
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const access = await taskAccess(supabase, user.id, taskId);
    if (!access) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    if (!access.canWork) return deny("Only people working on this task can attach files.");

    let attachment: any;
    let visibility: string;
    let sharedWith: string[];

    if ((request.headers.get("content-type") || "").includes("application/json")) {
      // The browser already put the file in storage through a one-time link
      // from ./upload; record it.
      const body = await request.json();
      visibility = String(body.visibility || "all");
      sharedWith = Array.isArray(body.shared_with) ? body.shared_with : [];
      const path = String(body.storage_path || "");
      if (!VISIBILITIES.includes(visibility)) {
        return NextResponse.json({ error: "visibility must be all, restricted or custom" }, { status: 400 });
      }
      if (!path.startsWith(`${taskId}/`) || path.includes("..")) {
        return NextResponse.json({ error: "That file doesn't belong to this task" }, { status: 400 });
      }
      if (Number(body.file_size) > MAX_BYTES) return NextResponse.json({ error: "File is larger than 25 MB" }, { status: 400 });
      const { data: taken } = await supabase.from("attachments").select("id").eq("storage_path", path).limit(1);
      if (taken && taken.length) return NextResponse.json({ error: "That file is already attached" }, { status: 400 });

      const { data, error } = await supabase
        .from("attachments")
        .insert({
          task_id: taskId,
          file_name: String(body.file_name || path.split("/").pop()),
          file_url: path, // kept for older NOT NULL schemas; the bucket is private
          storage_path: path,
          file_type: body.file_type || null,
          file_size: Number(body.file_size) || null,
          visibility,
          uploaded_by: user.id,
        })
        .select("*")
        .single();
      if (error) throw error;

      // Make sure the upload really finished before keeping the record.
      const { error: missing } = await supabase.storage.from(BUCKET).createSignedUrl(path, 10);
      if (missing) {
        await supabase.from("attachments").delete().eq("id", data.id);
        return NextResponse.json({ error: "The upload didn't finish - please try again" }, { status: 400 });
      }
      attachment = data;
    } else {
      // Small files can still come through the app directly.
      const form = await request.formData();
      const file = form.get("file");
      if (!file || typeof file === "string") return NextResponse.json({ error: "No file provided" }, { status: 400 });

      visibility = String(form.get("visibility") || "all");
      if (!VISIBILITIES.includes(visibility)) {
        return NextResponse.json({ error: "visibility must be all, restricted or custom" }, { status: 400 });
      }
      sharedWith = String(form.get("shared_with") || "").split(",").map((s) => s.trim()).filter(Boolean);

      const blob = file as File;
      if (blob.size > MAX_BYTES) return NextResponse.json({ error: "File is larger than 25 MB" }, { status: 400 });

      const path = `${taskId}/${Date.now()}-${safeFileName(blob.name)}`;

      const { error: uploadError } = await supabase.storage
        .from(BUCKET)
        .upload(path, blob, { contentType: blob.type || "application/octet-stream", upsert: false });
      if (uploadError) throw uploadError;

      const { data, error } = await supabase
        .from("attachments")
        .insert({
          task_id: taskId,
          file_name: blob.name,
          file_url: path, // kept for older NOT NULL schemas; the bucket is private
          storage_path: path,
          file_type: blob.type || null,
          file_size: blob.size,
          visibility,
          uploaded_by: user.id,
        })
        .select("*")
        .single();
      if (error) {
        await supabase.storage.from(BUCKET).remove([path]);
        throw error;
      }
      attachment = data;
    }

    const shared = visibility === "custom" ? await setSharedWith(supabase, attachment.id, access.task.desk_id, sharedWith) : [];

    await logActivity(supabase, {
      entity_type: "task",
      entity_id: taskId,
      action: `attached "${attachment.file_name}"${visibility !== "all" ? ` (${visibility})` : ""}`,
      performed_by: user.id,
      desk_id: access.task.desk_id,
      changes: { file: attachment.file_name, visibility },
    });

    const [named] = await attachNames(supabase, [present(attachment, user.id, access, shared)], "uploaded_by", "uploader_name");
    return NextResponse.json(named);
  } catch (error: any) {
    console.error("POST /api/tasks/[id]/attachments failed:", error);
    return NextResponse.json({ error: error?.message || "Upload failed" }, { status: 500 });
  }
}

// Change who can open a file. Only the uploader or someone managing the task.
export async function PUT(request: NextRequest, { params }: Params) {
  const { id: taskId } = await params;
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { attachment_id, visibility, shared_with } = await request.json();
    if (!attachment_id) return NextResponse.json({ error: "attachment_id required" }, { status: 400 });
    if (!VISIBILITIES.includes(visibility)) {
      return NextResponse.json({ error: "visibility must be all, restricted or custom" }, { status: 400 });
    }

    const access = await taskAccess(supabase, user.id, taskId);
    if (!access) return NextResponse.json({ error: "Task not found" }, { status: 404 });

    const { data: file } = await supabase.from("attachments").select("*").eq("id", attachment_id).maybeSingle();
    if (!file || file.task_id !== taskId) return NextResponse.json({ error: "File not found" }, { status: 404 });
    if (file.uploaded_by !== user.id && !access.canManage) {
      return deny("Only the uploader or the assignor can change file access.");
    }

    const { data, error } = await supabase
      .from("attachments")
      .update({ visibility })
      .eq("id", attachment_id)
      .select("*")
      .single();
    if (error) throw error;

    const shared =
      visibility === "custom"
        ? await setSharedWith(supabase, attachment_id, access.task.desk_id, Array.isArray(shared_with) ? shared_with : [])
        : (await supabase.from("attachment_access").delete().eq("attachment_id", attachment_id), []);

    await logActivity(supabase, {
      entity_type: "task",
      entity_id: taskId,
      action: `changed access to "${file.file_name}" to ${visibility}`,
      performed_by: user.id,
      desk_id: access.task.desk_id,
      changes: { visibility: { from: file.visibility || "all", to: visibility }, shared_with: shared },
    });

    const [named] = await attachNames(supabase, [present(data, user.id, access, shared)], "uploaded_by", "uploader_name");
    return NextResponse.json(named);
  } catch (error: any) {
    console.error("PUT /api/tasks/[id]/attachments failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const { id: taskId } = await params;
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { attachment_id } = await request.json();
    if (!attachment_id) return NextResponse.json({ error: "attachment_id required" }, { status: 400 });

    const access = await taskAccess(supabase, user.id, taskId);
    if (!access) return NextResponse.json({ error: "Task not found" }, { status: 404 });

    const { data: file } = await supabase.from("attachments").select("*").eq("id", attachment_id).maybeSingle();
    if (!file || file.task_id !== taskId) return NextResponse.json({ error: "File not found" }, { status: 404 });
    if (file.uploaded_by !== user.id && !access.canManage) {
      return deny("Only the uploader or the assignor can delete a file.");
    }

    // Remove the stored file first: the storage rule that allows it looks the
    // file up through this attachment row.
    const path = storagePathOf(file);
    if (path) {
      const { error: storageError } = await supabase.storage.from(BUCKET).remove([path]);
      if (storageError) console.error("could not remove stored file", path, storageError.message);
    }
    const { error } = await supabase.from("attachments").delete().eq("id", attachment_id);
    if (error) throw error;

    await logActivity(supabase, {
      entity_type: "task",
      entity_id: taskId,
      action: `deleted file "${file.file_name}"`,
      performed_by: user.id,
      desk_id: access.task.desk_id,
    });
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("DELETE /api/tasks/[id]/attachments failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
