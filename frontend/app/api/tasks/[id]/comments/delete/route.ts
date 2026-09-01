import { createServerSideClient } from "@/lib/supabase-server";
import { NextRequest, NextResponse } from "next/server";

export async function DELETE(request: NextRequest) {
  try {
    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { commentId } = await request.json();
    if (!commentId) return NextResponse.json({ error: "Comment ID required" }, { status: 400 });

    const { error } = await supabase
      .from("comments")
      .delete()
      .eq("id", commentId);

    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("DELETE comment failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
