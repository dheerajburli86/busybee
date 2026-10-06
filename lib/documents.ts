// Checklist #46 / #47: a standalone document library, separate from
// per-task attachments (#32). Files live in their own private bucket;
// access is desk-wide, project-scoped or private to the
// uploader - never "public". The list never exposes storage paths, only
// /api/documents/[id]/download, which re-checks access and hands out a
// short-lived signed link (same shape as lib/files.ts for task attachments).

import { SUPER_ROLES, getMemberships, roleIn, userProjectIds } from "@/lib/permissions";

export const DOC_BUCKET = "documents";
export const MAX_DOC_BYTES = 25 * 1024 * 1024;
export const VISIBILITIES = ["desk", "project", "private"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export function safeDocName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-150) || "file";
}

export type DocContext = {
  deskId: string;
  role: string;
  isSuper: boolean;
  projectIds: string[];
};

/** Load what this user may see across documents on their (first) desk. */
export async function docContext(supabase: any, userId: string): Promise<DocContext | null> {
  const memberships = await getMemberships(supabase, userId);
  const deskId = memberships[0]?.desk_id;
  if (!deskId) return null;
  const role = roleIn(memberships, deskId);
  const projectIds = await userProjectIds(supabase, userId);
  return { deskId, role, isSuper: SUPER_ROLES.includes(role), projectIds };
}

/** Whether a document is visible to this person, given their doc context. */
export function canSeeDocument(
  doc: { visibility: string; uploaded_by: string; project_id?: string | null },
  userId: string,
  ctx: DocContext
): boolean {
  if (ctx.isSuper) return true;
  if (doc.uploaded_by === userId) return true;
  switch (doc.visibility) {
    case "desk":
      return true;
    case "project":
      return !!doc.project_id && ctx.projectIds.includes(doc.project_id);
    case "private":
      return false;
    default:
      return false;
  }
}

/** Whether a person may delete/re-share a document: the uploader or a supervisor/admin. */
export function canManageDocument(doc: { uploaded_by: string }, userId: string, ctx: DocContext): boolean {
  return ctx.isSuper || doc.uploaded_by === userId;
}
