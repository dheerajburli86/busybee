// app/api/date-proposals/route.ts
import { createServerSideClient } from "@/lib/supabase";
import { NextRequest, NextResponse } from "next/server";

// GET /api/date-proposals?task_id=xxx - get proposals for a task
export async function GET(request: NextRequest) {
  try {
    const supabase = await createServerSideClient();
    const taskId = request.nextUrl.searchParams.get("task_id");

    if (!taskId) {
      return NextResponse.json(
        { error: "task_id required" },
        { status: 400 }
      );
    }

    const { data: proposals, error } = await supabase
      .from("date_proposals")
      .select(
        `
        id,
        proposed_by,
        proposed_datetime,
        reason,
        status,
        approved_by,
        counter_datetime,
        counter_reason,
        created_at,
        updated_at
      `
      )
      .eq("task_id", taskId)
      .order("created_at", { ascending: false });

    if (error) throw error;

    return NextResponse.json({ proposals });
  } catch (error) {
    console.error("Error fetching proposals:", error);
    return NextResponse.json(
      { error: "Failed to fetch proposals" },
      { status: 500 }
    );
  }
}

// POST /api/date-proposals - create or respond to a proposal
export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSideClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { task_id, proposed_datetime, reason, action, counter_datetime } =
      body;

    // Get task and verify user access
    const { data: task, error: taskError } = await supabase
      .from("tasks")
      .select("desk_id, assigned_to")
      .eq("id", task_id)
      .single();

    if (taskError) throw taskError;

    // Verify user is in the desk
    const { data: member } = await supabase
      .from("desk_members")
      .select("role")
      .eq("desk_id", task.desk_id)
      .eq("user_id", user.id)
      .single();

    if (!member) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    // Handle different actions
    if (action === "propose") {
      // Junior proposes a date
      const { data: proposal, error } = await supabase
        .from("date_proposals")
        .insert({
          task_id,
          proposed_by: user.id,
          proposed_datetime,
          reason,
          status: "pending",
        })
        .select()
        .single();

      if (error) throw error;

      // Create notification for supervisors
      const { data: supervisors } = await supabase
        .from("desk_members")
        .select("user_id")
        .eq("desk_id", task.desk_id)
        .in("role", ["supervisor", "owner"]);

      if (supervisors) {
        for (const sup of supervisors) {
          await supabase.from("notifications").insert({
            user_id: sup.user_id,
            task_id,
            type: "timeline_proposal_pending",
            title: "Timeline Awaiting Approval",
            message: `A task timeline proposal is pending your review`,
            action_url: `/tasks/${task_id}`,
          });
        }
      }

      // Log activity
      await supabase.from("activity_log").insert({
        entity_type: "date_proposal",
        entity_id: proposal.id,
        action: "created",
        performed_by: user.id,
        desk_id: task.desk_id,
        changes: {
          proposed_datetime,
          reason,
        },
      });

      return NextResponse.json({ proposal });
    } else if (action === "approve") {
      // Supervisor approves a proposal
      if (member.role !== "supervisor" && member.role !== "owner") {
        return NextResponse.json(
          { error: "Only supervisors can approve" },
          { status: 403 }
        );
      }

      // Get the latest proposal
      const { data: latestProposal, error: propError } = await supabase
        .from("date_proposals")
        .select("id, proposed_datetime, proposed_by")
        .eq("task_id", task_id)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (propError || !latestProposal) {
        return NextResponse.json(
          { error: "No pending proposal found" },
          { status: 404 }
        );
      }

      // Approve the proposal
      const { error: updateError } = await supabase
        .from("date_proposals")
        .update({
          status: "approved",
          approved_by: user.id,
          updated_at: new Date(),
        })
        .eq("id", latestProposal.id);

      if (updateError) throw updateError;

      // Create approved deadline
      const { error: deadlineError } = await supabase
        .from("approved_deadlines")
        .upsert(
          {
            task_id,
            approved_datetime: latestProposal.proposed_datetime,
            timer_started_at: new Date(),
          },
          { onConflict: "task_id" }
        );

      if (deadlineError) throw deadlineError;

      // Notify the junior
      await supabase.from("notifications").insert({
        user_id: latestProposal.proposed_by,
        task_id,
        type: "timeline_approved",
        title: "Timeline Approved",
        message: `Your proposed timeline has been approved. Work begins now.`,
        action_url: `/tasks/${task_id}`,
      });

      // Log activity
      await supabase.from("activity_log").insert({
        entity_type: "date_proposal",
        entity_id: latestProposal.id,
        action: "approved",
        performed_by: user.id,
        desk_id: task.desk_id,
        changes: {
          status: { before: "pending", after: "approved" },
        },
      });

      return NextResponse.json({
        message: "Proposal approved",
        deadline: latestProposal.proposed_datetime,
      });
    } else if (action === "counter") {
      // Supervisor proposes alternative date
      if (member.role !== "supervisor" && member.role !== "owner") {
        return NextResponse.json(
          { error: "Only supervisors can counter" },
          { status: 403 }
        );
      }

      const { data: latestProposal } = await supabase
        .from("date_proposals")
        .select("id, proposed_by")
        .eq("task_id", task_id)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (!latestProposal) {
        return NextResponse.json(
          { error: "No pending proposal" },
          { status: 404 }
        );
      }

      const { error } = await supabase
        .from("date_proposals")
        .update({
          status: "countered",
          counter_datetime,
          approved_by: user.id,
        })
        .eq("id", latestProposal.id);

      if (error) throw error;

      // Notify junior of counter
      await supabase.from("notifications").insert({
        user_id: latestProposal.proposed_by,
        task_id,
        type: "timeline_countered",
        title: "Timeline Counter-Proposal",
        message: `Your timeline proposal was countered. Please review and respond.`,
        action_url: `/tasks/${task_id}`,
      });

      return NextResponse.json({ message: "Counter-proposal sent" });
    }

    return NextResponse.json(
      { error: "Invalid action" },
      { status: 400 }
    );
  } catch (error) {
    console.error("Error processing proposal:", error);
    return NextResponse.json(
      { error: "Failed to process proposal" },
      { status: 500 }
    );
  }
}
