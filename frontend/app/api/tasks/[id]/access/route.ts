import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";
import { requireUser, taskAccess } from "@/lib/permissions";

// Tells the UI which controls to show for one task. The server re-checks on
// every write, so this only decides what is visible, never what is allowed.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const access = await taskAccess(supabase, user.id, id);
    if (!access) return NextResponse.json({ error: "Task not found" }, { status: 404 });

    return NextResponse.json({
      canManage: access.canManage,
      canWork: access.canWork,
      isSuper: access.isSuper,
      isAssignor: access.isAssignor,
      role: access.role,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
