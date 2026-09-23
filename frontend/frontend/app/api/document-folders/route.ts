// app/api/document-folders/route.ts
//
// Checklist #46: folders that organize the document library. The documents
// inside a folder carry their own visibility (#47), and a folder is only
// listed to someone who may see something inside it (or who made it) - a
// folder name gives away as much as its contents. That filtering lives with
// the listing, in app/api/documents/route.ts; renaming and deleting a folder
// stay with its creator and with supervisors/admins, below.

import { createServerSideClient } from "@/lib/supabase-server";
import { NextRequest, NextResponse } from "next/server";
import { deny, requireUser } from "@/lib/permissions";
import { docContext } from "@/lib/documents";

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const ctx = await docContext(supabase, user.id);
    if (!ctx) return NextResponse.json({ error: "No desk found" }, { status: 400 });

    const { name, parent_id } = await request.json();
    if (!name?.trim()) return NextResponse.json({ error: "A folder name is required" }, { status: 400 });

    if (parent_id) {
      const { data: parent } = await supabase.from("document_folders").select("desk_id").eq("id", parent_id).maybeSingle();
      if (!parent || parent.desk_id !== ctx.deskId) return NextResponse.json({ error: "Folder not found" }, { status: 404 });
    }

    const { data, error } = await supabase
      .from("document_folders")
      .insert({ desk_id: ctx.deskId, parent_id: parent_id || null, name: name.trim(), created_by: user.id })
      .select("id, name, parent_id, created_at")
      .single();
    if (error) throw error;
    return NextResponse.json(data);
  } catch (error: any) {
    console.error("POST /api/document-folders failed:", error);
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

    const { id, name } = await request.json();
    if (!id || !name?.trim()) return NextResponse.json({ error: "id and name required" }, { status: 400 });

    const { data: folder } = await supabase.from("document_folders").select("*").eq("id", id).maybeSingle();
    if (!folder || folder.desk_id !== ctx.deskId) return NextResponse.json({ error: "Folder not found" }, { status: 404 });
    if (!ctx.isSuper && folder.created_by !== user.id) return deny("Only a supervisor or this folder's creator can rename it.");

    const { data, error } = await supabase
      .from("document_folders")
      .update({ name: name.trim() })
      .eq("id", id)
      .select("id, name, parent_id, created_at")
      .single();
    if (error) throw error;
    return NextResponse.json(data);
  } catch (error: any) {
    console.error("PUT /api/document-folders failed:", error);
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

    const { data: folder } = await supabase.from("document_folders").select("*").eq("id", id).maybeSingle();
    if (!folder || folder.desk_id !== ctx.deskId) return NextResponse.json({ error: "Folder not found" }, { status: 404 });
    if (!ctx.isSuper && folder.created_by !== user.id) return deny("Only a supervisor or this folder's creator can delete it.");

    const [{ count: subCount }, { count: docCount }] = await Promise.all([
      supabase.from("document_folders").select("id", { count: "exact", head: true }).eq("parent_id", id),
      supabase.from("documents").select("id", { count: "exact", head: true }).eq("folder_id", id),
    ]);
    if ((subCount || 0) > 0 || (docCount || 0) > 0) {
      return NextResponse.json({ error: "Empty this folder first (move or delete its contents)." }, { status: 400 });
    }

    const { error } = await supabase.from("document_folders").delete().eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("DELETE /api/document-folders failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
