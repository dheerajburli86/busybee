// app/api/documents/route.ts
//
// Checklist #46: a standalone document library (separate from per-task
// attachments, #32) with folders and per-document visibility (#47).
// GET lists one folder's contents (sub-folders + documents this person may
// see). POST registers a file after it has already been uploaded straight
// to storage via a signed link (see ./upload/route.ts) - the same two-step
// pattern used for task attachments, because Vercel caps a request through
// the app at 4.5 MB. PUT changes a document's visibility/folder; DELETE
// removes it (and its storage object).

import { createServerSideClient } from "@/lib/supabase-server";
import { NextRequest, NextResponse } from "next/server";
import { deny, requireUser } from "@/lib/permissions";
import { attachNames } from "@/lib/names";
import {
  DOC_BUCKET,
  VISIBILITIES,
  canManageDocument,
  canSeeDocument,
  docContext,
} from "@/lib/documents";

export async function GET(request: NextRequest) {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const ctx = await docContext(supabase, user.id);
    if (!ctx) return NextResponse.json({ folders: [], documents: [], role: "member" });

    const folderId = request.nextUrl.searchParams.get("folder_id") || null;

    let folderQuery = supabase
      .from("document_folders")
      .select("id, name, parent_id, created_by, created_at")
      .eq("desk_id", ctx.deskId);
    folderQuery = folderId ? folderQuery.eq("parent_id", folderId) : folderQuery.is("parent_id", null);

    let docQuery = supabase
      .from("documents")
      .select("id, name, folder_id, file_size, file_type, visibility, project_id, uploaded_by, created_at")
      .eq("desk_id", ctx.deskId)
      .order("created_at", { ascending: false });
    docQuery = folderId ? docQuery.eq("folder_id", folderId) : docQuery.is("folder_id", null);

    const [{ data: folders }, { data: docs }] = await Promise.all([folderQuery, docQuery]);

    const visibleDocs = (docs || []).filter((d: any) => canSeeDocument(d, user.id, ctx));
    const withNames = await attachNames(supabase, visibleDocs, "uploaded_by", "uploaded_by_name");

    let breadcrumb: { id: string; name: string }[] = [];
    if (folderId) {
      let cur: any = { id: folderId };
      const chain: { id: string; name: string }[] = [];
      let guard = 0;
      while (cur?.id && guard++ < 25) {
        const { data: f } = await supabase.from("document_folders").select("id, name, parent_id").eq("id", cur.id).maybeSingle();
        if (!f) break;
        chain.unshift({ id: f.id, name: f.name });
        cur = f.parent_id ? { id: f.parent_id } : null;
      }
      breadcrumb = chain;
    }

    return NextResponse.json({
      folders: folders || [],
      documents: withNames.map((d: any) => ({ ...d, can_manage: canManageDocument(d, user.id, ctx) })),
      role: ctx.role,
      isSuper: ctx.isSuper,
      breadcrumb,
    });
  } catch (error: any) {
    console.error("GET /api/documents failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

// Register a file already uploaded to storage (see ./upload).
export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const ctx = await docContext(supabase, user.id);
    if (!ctx) return NextResponse.json({ error: "No desk found" }, { status: 400 });

    const body = await request.json();
    const { storage_path, name, file_size, file_type, folder_id, visibility = "desk", project_id } = body;
    if (!storage_path || !name) return NextResponse.json({ error: "storage_path and name required" }, { status: 400 });
    if (!VISIBILITIES.includes(visibility)) return NextResponse.json({ error: "Unknown visibility" }, { status: 400 });

    if (folder_id) {
      const { data: f } = await supabase.from("document_folders").select("desk_id").eq("id", folder_id).maybeSingle();
      if (!f || f.desk_id !== ctx.deskId) return NextResponse.json({ error: "Folder not found" }, { status: 404 });
    }
    if (visibility === "project" && project_id) {
      const { data: pr } = await supabase.from("projects").select("desk_id").eq("id", project_id).maybeSingle();
      if (!pr || pr.desk_id !== ctx.deskId) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const { data, error } = await supabase
      .from("documents")
      .insert({
        desk_id: ctx.deskId,
        folder_id: folder_id || null,
        name: String(name).slice(0, 255),
        storage_path,
        file_size: file_size || null,
        file_type: file_type || null,
        visibility,
        project_id: visibility === "project" ? project_id || null : null,
        uploaded_by: user.id,
      })
      .select("id, name, folder_id, file_size, file_type, visibility, project_id, uploaded_by, created_at")
      .single();
    if (error) throw error;

    return NextResponse.json({ ...data, can_manage: true });
  } catch (error: any) {
    console.error("POST /api/documents failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const ctx = await docContext(supabase, user.id);
    if (!ctx) return NextResponse.json({ error: "No desk found" }, { status: 400 });

    const body = await request.json();
    const { id } = body;
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const { data: doc } = await supabase.from("documents").select("*").eq("id", id).maybeSingle();
    if (!doc || doc.desk_id !== ctx.deskId) return NextResponse.json({ error: "Document not found" }, { status: 404 });
    if (!canManageDocument(doc, user.id, ctx)) return deny("Only the person who uploaded this file, or a supervisor, can change it.");

    const patch: Record<string, any> = {};
    if ("name" in body && String(body.name).trim()) patch.name = String(body.name).trim().slice(0, 255);
    if ("folder_id" in body) {
      if (body.folder_id) {
        const { data: f } = await supabase.from("document_folders").select("desk_id").eq("id", body.folder_id).maybeSingle();
        if (!f || f.desk_id !== ctx.deskId) return NextResponse.json({ error: "Folder not found" }, { status: 404 });
      }
      patch.folder_id = body.folder_id || null;
    }
    if ("visibility" in body) {
      if (!VISIBILITIES.includes(body.visibility)) return NextResponse.json({ error: "Unknown visibility" }, { status: 400 });
      patch.visibility = body.visibility;
      patch.project_id = body.visibility === "project" ? body.project_id || null : null;
    }
    if (Object.keys(patch).length === 0) return NextResponse.json({ error: "Nothing to update" }, { status: 400 });

    const { data, error } = await supabase
      .from("documents")
      .update(patch)
      .eq("id", id)
      .select("id, name, folder_id, file_size, file_type, visibility, project_id, uploaded_by, created_at")
      .single();
    if (error) throw error;
    return NextResponse.json({ ...data, can_manage: true });
  } catch (error: any) {
    console.error("PUT /api/documents failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const ctx = await docContext(supabase, user.id);
    if (!ctx) return NextResponse.json({ error: "No desk found" }, { status: 400 });

    const { id } = await request.json();
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const { data: doc } = await supabase.from("documents").select("*").eq("id", id).maybeSingle();
    if (!doc || doc.desk_id !== ctx.deskId) return NextResponse.json({ error: "Document not found" }, { status: 404 });
    if (!canManageDocument(doc, user.id, ctx)) return deny("Only the person who uploaded this file, or a supervisor, can delete it.");

    await supabase.storage.from(DOC_BUCKET).remove([doc.storage_path]).catch(() => {});
    const { error } = await supabase.from("documents").delete().eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("DELETE /api/documents failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
