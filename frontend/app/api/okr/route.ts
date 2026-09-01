import { createServerSideClient } from "@/lib/supabase-server";
import { NextResponse } from "next/server";

// SOW #35 / #36: objectives with key results, and tasks linked to them.
async function deskFor(supabase: any, userId: string) {
  const { data } = await supabase
    .from("desk_members")
    .select("desk_id")
    .eq("user_id", userId)
    .limit(1)
    .single();
  return data?.desk_id ?? null;
}

export async function GET() {
  try {
    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const deskId = await deskFor(supabase, user.id);
    if (!deskId) return NextResponse.json({ objectives: [], keyResults: [] });

    const { data: objectives, error } = await supabase
      .from("objectives")
      .select("id, title, description, period, created_at")
      .eq("desk_id", deskId)
      .order("created_at", { ascending: false });

    if (error) throw error;

    const ids = (objectives || []).map((o: any) => o.id);
    let keyResults: any[] = [];
    if (ids.length > 0) {
      const { data: krs } = await supabase
        .from("key_results")
        .select("id, objective_id, title, target_value, current_value, unit")
        .in("objective_id", ids);
      keyResults = krs || [];
    }

    return NextResponse.json({ objectives: objectives || [], keyResults });
  } catch (error: any) {
    console.error("GET /api/okr failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    // Adding a key result to an existing objective.
    if (body.objective_id) {
      if (!body.title?.trim()) {
        return NextResponse.json({ error: "Key result needs a title" }, { status: 400 });
      }
      const { data, error } = await supabase
        .from("key_results")
        .insert({
          objective_id: body.objective_id,
          title: body.title.trim(),
          target_value: body.target_value ?? 100,
          current_value: body.current_value ?? 0,
          unit: body.unit || "percent",
        })
        .select("id, objective_id, title, target_value, current_value, unit")
        .single();
      if (error) throw error;
      return NextResponse.json(data);
    }

    // Otherwise create the objective itself.
    if (!body.title?.trim()) {
      return NextResponse.json({ error: "Objective needs a title" }, { status: 400 });
    }

    const deskId = await deskFor(supabase, user.id);
    if (!deskId) return NextResponse.json({ error: "No desk found" }, { status: 400 });

    const { data, error } = await supabase
      .from("objectives")
      .insert({
        desk_id: deskId,
        title: body.title.trim(),
        description: body.description || null,
        period: body.period || null,
        owner_id: user.id,
      })
      .select("id, title, description, period, created_at")
      .single();

    if (error) throw error;
    return NextResponse.json(data);
  } catch (error: any) {
    console.error("POST /api/okr failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

// Update a key result's current value.
export async function PUT(req: Request) {
  try {
    const { key_result_id, current_value } = await req.json();
    if (!key_result_id) {
      return NextResponse.json({ error: "key_result_id required" }, { status: 400 });
    }

    const supabase = await createServerSideClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data, error } = await supabase
      .from("key_results")
      .update({ current_value: Number(current_value) || 0 })
      .eq("id", key_result_id)
      .select("id, objective_id, title, target_value, current_value, unit")
      .single();

    if (error) throw error;
    return NextResponse.json(data);
  } catch (error: any) {
    console.error("PUT /api/okr failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}
