// Opens a document after checking the person may see it (checklist #47).
// Issues a signed link valid for one minute, so a copied link stops
// working quickly - same pattern as task attachments' download route.

import { createServerSideClient } from "@/lib/supabase-server";
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/permissions";
import { DOC_BUCKET, canSeeDocument, docContext } from "@/lib/documents";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.redirect(new URL("/login", request.url));

    const { data: doc } = await supabase.from("documents").select("*").eq("id", id).maybeSingle();
    if (!doc) return NextResponse.json({ error: "File not found" }, { status: 404 });

    const ctx = await docContext(supabase, user.id);
    if (!ctx || ctx.deskId !== doc.desk_id || !canSeeDocument(doc, user.id, ctx)) {
      return NextResponse.json({ error: "You don't have access to this file" }, { status: 403 });
    }

    const download = request.nextUrl.searchParams.get("download") === "1";
    const { data, error } = await supabase.storage
      .from(DOC_BUCKET)
      .createSignedUrl(doc.storage_path, 60, download ? { download: doc.name } : undefined);
    if (error || !data?.signedUrl) throw error || new Error("Could not create a link");

    return NextResponse.redirect(data.signedUrl);
  } catch (error: any) {
    console.error("GET /api/documents/[id]/download failed:", error);
    return NextResponse.json({ error: error?.message || "Could not open file" }, { status: 500 });
  }
}
