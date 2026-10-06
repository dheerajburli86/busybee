// Opens a file after checking the person may see it (checklist #47). Issues a
// signed link valid for one minute, so a copied link stops working quickly.

import { createServerSideClient } from "@/lib/supabase-server";
import { NextRequest, NextResponse } from "next/server";
import { requireUser, taskAccess } from "@/lib/permissions";
import { BUCKET, canOpen, extraAssignorIds, storagePathOf } from "@/lib/files";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.redirect(new URL("/login", request.url));

    const { data: file } = await supabase.from("attachments").select("*").eq("id", id).maybeSingle();
    if (!file) return NextResponse.json({ error: "File not found" }, { status: 404 });

    const access = await taskAccess(supabase, user.id, file.task_id);
    if (!access) return NextResponse.json({ error: "File not found" }, { status: 404 });

    const [extra, { data: shared }] = await Promise.all([
      extraAssignorIds(supabase, file.task_id),
      supabase.from("attachment_access").select("user_id").eq("attachment_id", id),
    ]);
    if (!canOpen(file, user.id, access, extra, (shared || []).map((s: any) => s.user_id))) {
      return NextResponse.json({ error: "You don't have access to this file" }, { status: 403 });
    }

    const path = storagePathOf(file);
    if (!path) return NextResponse.json({ error: "File is missing from storage" }, { status: 404 });

    const download = request.nextUrl.searchParams.get("download") === "1";
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(path, 60, download ? { download: file.file_name } : undefined);
    if (error || !data?.signedUrl) throw error || new Error("Could not create a link");

    return NextResponse.redirect(data.signedUrl);
  } catch (error: any) {
    console.error("GET /api/attachments/[id]/download failed:", error);
    return NextResponse.json({ error: error?.message || "Could not open file" }, { status: 500 });
  }
}
