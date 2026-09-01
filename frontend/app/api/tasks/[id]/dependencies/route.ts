import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: deps, error } = await supabase
      .from("task_dependencies")
      .select("depends_on_task_id")
      .eq("task_id", id);

    if (error) throw error;
    return NextResponse.json(deps || []);
  } catch (error: any) {
    console.error("GET /api/tasks/[id]/dependencies failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { depends_on_task_id, dependency_type } = await req.json();
    
    if (!depends_on_task_id) {
      return NextResponse.json({ error: "depends_on_task_id required" }, { status: 400 });
    }

    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    if (id === depends_on_task_id) {
      return NextResponse.json({ error: "Task cannot depend on itself" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("task_dependencies")
      .insert({
        task_id: id,
        depends_on_task_id,
        dependency_type: dependency_type || "blocks",
      })
      .select("id");

    if (error) throw error;
    return NextResponse.json({ success: true, id: data?.[0]?.id });
  } catch (error: any) {
    console.error("POST /api/tasks/[id]/dependencies failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
