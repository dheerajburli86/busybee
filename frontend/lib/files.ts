// Checklist #47 / SOW #32: who may open a file.
//
//   all        - everyone who can see the task
//   restricted - the uploader, the task's assignor(s), task manager,
//                assignee, and supervisors/admins
//   custom     - the restricted set plus specific people chosen by the uploader
//
// The same rule lives in the database as can_view_attachment() so the storage
// bucket enforces it too; this copy lets the API filter lists cheaply.

import { SUPER_ROLES, TaskAccess } from "@/lib/permissions";

export const BUCKET = "task-files";
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || "file";
}

export async function extraAssignorIds(supabase: any, taskId: string): Promise<string[]> {
  const { data } = await supabase.from("task_assignors").select("user_id").eq("task_id", taskId);
  return (data || []).map((x: any) => x.user_id);
}

export function canOpen(
  file: { visibility: string | null; uploaded_by: string | null },
  userId: string,
  access: TaskAccess,
  extraAssignors: string[],
  sharedWith: string[]
): boolean {
  if (!access.canView) return false;
  const v = file.visibility || "all";
  if (v === "all") return true;
  const t = access.task;
  const inner =
    file.uploaded_by === userId ||
    t.created_by === userId ||
    t.assigned_to === userId ||
    t.task_manager_id === userId ||
    extraAssignors.includes(userId) ||
    SUPER_ROLES.includes(access.role);
  if (inner) return true;
  return v === "custom" && sharedWith.includes(userId);
}

/** Path inside the bucket, recovered from the old public URL if needed. */
export function storagePathOf(file: { storage_path?: string | null; file_url?: string | null }): string | null {
  if (file.storage_path) return file.storage_path;
  const url = file.file_url || "";
  const i = url.indexOf(`/${BUCKET}/`);
  return i >= 0 ? decodeURIComponent(url.slice(i + BUCKET.length + 2)) : null;
}
