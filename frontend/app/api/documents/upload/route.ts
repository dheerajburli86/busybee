// Checklist #46 / #32-style flow: files up to 25 MB go straight from the
// browser to storage. The app only hands out a one-time upload link here
// (after checking the person is on a desk) and the file is registered
// afterwards (POST /api/documents).

import { randomUUID } from "node:crypto";
import { createServerSideClient } from "@/lib/supabase-server";
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/permissions";
import { DOC_BUCKET, MAX_DOC_BYTES, docContext, safeDocName } from "@/lib/documents";

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const ctx = await docContext(supabase, user.id);
    if (!ctx) return NextResponse.json({ error: "No desk found" }, { status: 400 });

    const { file_name, file_size } = await request.json();
    if (!file_name) return NextResponse.json({ error: "file_name required" }, { status: 400 });
    if (Number(file_size) > MAX_DOC_BYTES) return NextResponse.json({ error: "File is larger than 25 MB" }, { status: 400 });

    const path = `${ctx.deskId}/${randomUUID()}-${safeDocName(String(file_name))}`;
    const { data, error } = await supabase.storage.from(DOC_BUCKET).createSignedUploadUrl(path);
    if (error || !data) throw error || new Error("Could not start the upload");

    return NextResponse.json({ path: data.path, token: data.token });
  } catch (error: any) {
    console.error("POST /api/documents/upload failed:", error);
    return NextResponse.json({ error: error?.message || "Could not start the upload" }, { status: 500 });
  }
}
