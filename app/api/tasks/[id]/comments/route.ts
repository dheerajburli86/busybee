// app/api/tasks/[id]/comments/route.ts
//
// Checklist #29 / SOW #23: a comment trail with author and time, @tagging of
// people and projects, and edit/delete of your own comments.
// Checklist #31: a comment can be private - sent to chosen people and hidden
// from everyone else on the task. The database enforces that too (see the
// comments policies in the migration), so it holds for search as well.

import { createServerSideClient } from "@/lib/supabase-server";
import { NextRequest, NextResponse } from "next/server";
import { deny, logActivity, notifyMany, requireUser, taskAccess, SUPER_ROLES } from "@/lib/permissions";
import { handleFor, mentionsIn } from "@/lib/mentions";
import { sendMail } from "@/lib/email";

type Params = { params: Promise<{ id: string }> };
const COLUMNS = "id, content, author_id, created_at, updated_at, edited, is_private";
const MAX_LENGTH = 5000;

async function present(supabase: any, userId: string, rows: any[]) {
  const privateIds = rows.filter((r) => r.is_private).map((r) => r.id);
  const recipients: Record<string, string[]> = {};
  if (privateIds.length) {
    const { data } = await supabase.from("comment_recipients").select("comment_id, user_id").in("comment_id", privateIds);
    (data || []).forEach((r: any) => (recipients[r.comment_id] = [...(recipients[r.comment_id] || []), r.user_id]));
  }
  const ids = Array.from(new Set([...rows.map((r) => r.author_id), ...Object.values(recipients).flat()].filter(Boolean)));
  const { data: users } = ids.length ? await supabase.from("users").select("id, full_name, email").in("id", ids) : { data: [] };
  const nameOf = new Map((users || []).map((u: any) => [u.id, u.full_name || u.email]));
  return rows
    // Belt and braces: never hand back a private comment to someone outside it.
    .filter((r) => !r.is_private || r.author_id === userId || (recipients[r.id] || []).includes(userId))
    .map((r) => ({
      ...r,
      is_private: !!r.is_private,
      author_name: nameOf.get(r.author_id) || "Someone",
      recipients: r.is_private ? recipients[r.id] || [] : undefined,
      recipient_names: r.is_private ? (recipients[r.id] || []).map((id) => nameOf.get(id) || "Someone") : undefined,
    }));
}

/** @handles in the text -> the people they refer to on this desk. */
async function mentionedPeople(supabase: any, deskId: string, content: string): Promise<Set<string>> {
  const mentions = mentionsIn(content);
  const recipients = new Set<string>();
  if (mentions.length === 0) return recipients;

  const slug = handleFor;

  const { data: mates } = await supabase
    .from("desk_members")
    .select("user_id, users(id, email, full_name)")
    .eq("desk_id", deskId);
  for (const dm of mates || []) {
    const u: any = (dm as any).users;
    if (!u) continue;
    const handles = [slug(u.full_name || ""), slug((u.email || "").split("@")[0])].filter(Boolean);
    if (mentions.some((m) => handles.includes(m))) recipients.add(u.id);
  }

  const { data: projects } = await supabase.from("projects").select("id, name").eq("desk_id", deskId);
  const projectIds = (projects || []).filter((p: any) => mentions.includes(slug(p.name))).map((p: any) => p.id);

  if (projectIds.length) {
    const [{ data: members }, { data: led }] = await Promise.all([
      supabase.from("project_members").select("user_id").in("project_id", projectIds),
      supabase.from("projects").select("manager_id").in("id", projectIds),
    ]);
    (members || []).forEach((m: any) => m.user_id && recipients.add(m.user_id));
    // A project's manager is part of the project for tagging too.
    (led || []).forEach((p: any) => p.manager_id && recipients.add(p.manager_id));
  }
  return recipients;
}

export async function GET(_request: NextRequest, { params }: Params) {
  const { id: taskId } = await params;
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const access = await taskAccess(supabase, user.id, taskId);
    if (!access?.canView) return NextResponse.json({ error: "Task not found" }, { status: 404 });

    const { data, error } = await supabase
      .from("comments")
      .select(COLUMNS)
      .eq("task_id", taskId)
      .order("created_at", { ascending: false });
    if (error) throw error;

    return NextResponse.json(await present(supabase, user.id, data || []));
  } catch (error: any) {
    console.error("GET /api/tasks/[id]/comments failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  const { id: taskId } = await params;
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const access = await taskAccess(supabase, user.id, taskId);
    if (!access?.canView) return NextResponse.json({ error: "Task not found" }, { status: 404 });

    const body = await request.json();
    const content = String(body.content || "").trim();
    if (!content) return NextResponse.json({ error: "Content required" }, { status: 400 });
    if (content.length > MAX_LENGTH) return NextResponse.json({ error: "That comment is too long" }, { status: 400 });

    // #31: a private comment goes only to the people chosen for it.
    const wanted: string[] = Array.from(
      new Set<string>((Array.isArray(body.private_to) ? body.private_to : []).filter((x: any) => typeof x === "string" && x && x !== user.id))
    );
    const isPrivate = wanted.length > 0;
    let privateTo: string[] = [];
    if (isPrivate) {
      const { data: mates } = await supabase
        .from("desk_members")
        .select("user_id")
        .eq("desk_id", access.task.desk_id)
        .in("user_id", wanted);
      privateTo = (mates || []).map((m: any) => m.user_id);
      if (privateTo.length !== wanted.length) {
        return NextResponse.json({ error: "Someone you picked isn't on this desk" }, { status: 400 });
      }
    } else if (body.private_to !== undefined && Array.isArray(body.private_to) && body.private_to.length) {
      return NextResponse.json({ error: "Pick at least one other person for a private comment" }, { status: 400 });
    }

    const { data: comment, error } = await supabase
      .from("comments")
      .insert({ task_id: taskId, author_id: user.id, content, ...(isPrivate ? { is_private: true } : {}) })
      .select(COLUMNS)
      .single();
    if (error) throw error;

    if (isPrivate) {
      const { error: recipientError } = await supabase
        .from("comment_recipients")
        .insert(privateTo.map((user_id) => ({ comment_id: comment.id, user_id })));
      if (recipientError) {
        // Don't leave a private comment nobody can be told about.
        await supabase.from("comments").delete().eq("id", comment.id);
        throw recipientError;
      }
    }

    const tagged = await mentionedPeople(supabase, access.task.desk_id, content);
    tagged.delete(user.id);
    if (isPrivate) {
      // Only the chosen people ever see a private comment, and all of them hear about it.
      await notifyMany(supabase, privateTo, {
        task_id: taskId,
        type: "private_comment",
        title: "Private comment for you",
        message: `On "${access.task.title}": ${content.slice(0, 140)}`,
      });
      await sendMail({ userIds: privateTo, subject: `Private comment on ${access.task.title}`, body: content, type: "private_comment" });
    } else {
      await notifyMany(supabase, Array.from(tagged), {
        task_id: taskId,
        type: "mention",
        title: "You were mentioned",
        message: content.slice(0, 140),
      });
    }

    await logActivity(supabase, {
      entity_type: "task",
      entity_id: taskId,
      // The history is visible to everyone on the task, so a private comment's
      // text and recipients stay out of it.
      action: isPrivate ? "sent a private comment" : "commented",
      performed_by: user.id,
      desk_id: access.task.desk_id,
      changes: isPrivate ? null : { comment: content.slice(0, 200) },
    });

    const [shown] = await present(supabase, user.id, [comment]);
    return NextResponse.json(shown);
  } catch (error: any) {
    console.error("POST /api/tasks/[id]/comments failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

// Edit your own comment.
export async function PUT(request: NextRequest, { params }: Params) {
  const { id: taskId } = await params;
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { comment_id, content } = await request.json();
    if (!comment_id) return NextResponse.json({ error: "comment_id required" }, { status: 400 });
    const text = String(content || "").trim();
    if (!text) return NextResponse.json({ error: "Content required" }, { status: 400 });
    if (text.length > MAX_LENGTH) return NextResponse.json({ error: "That comment is too long" }, { status: 400 });

    const access = await taskAccess(supabase, user.id, taskId);
    if (!access?.canView) return NextResponse.json({ error: "Task not found" }, { status: 404 });

    const { data: existing } = await supabase
      .from("comments")
      .select("id, task_id, author_id")
      .eq("id", comment_id)
      .maybeSingle();
    if (!existing || existing.task_id !== taskId) {
      return NextResponse.json({ error: "Comment not found" }, { status: 404 });
    }
    if (existing.author_id !== user.id) return deny("You can only edit your own comments.");

    const { data, error } = await supabase
      .from("comments")
      .update({ content: text, edited: true, updated_at: new Date().toISOString() })
      .eq("id", comment_id)
      .select(COLUMNS)
      .single();
    if (error) throw error;

    const [shown] = await present(supabase, user.id, [data]);
    return NextResponse.json(shown);
  } catch (error: any) {
    console.error("PUT /api/tasks/[id]/comments failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

// Delete: the author, or a supervisor/admin moderating.
export async function DELETE(request: NextRequest, { params }: Params) {
  const { id: taskId } = await params;
  try {
    const supabase = await createServerSideClient();
    const user = await requireUser(supabase);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const commentId = body.comment_id || body.commentId;
    if (!commentId) return NextResponse.json({ error: "comment_id required" }, { status: 400 });

    const access = await taskAccess(supabase, user.id, taskId);
    if (!access) return NextResponse.json({ error: "Task not found" }, { status: 404 });

    const { data: existing } = await supabase
      .from("comments")
      .select("id, task_id, author_id, is_private")
      .eq("id", commentId)
      .maybeSingle();
    if (!existing || existing.task_id !== taskId) {
      return NextResponse.json({ error: "Comment not found" }, { status: 404 });
    }
    // A private comment can only be removed by whoever wrote it.
    const moderator = SUPER_ROLES.includes(access.role) && !existing.is_private;
    if (existing.author_id !== user.id && !moderator) {
      return deny("You can only delete your own comments.");
    }

    const { error } = await supabase.from("comments").delete().eq("id", commentId);
    if (error) throw error;

    await logActivity(supabase, {
      entity_type: "task",
      entity_id: taskId,
      action: existing.is_private ? "deleted a private comment" : "deleted a comment",
      performed_by: user.id,
      desk_id: access.task.desk_id,
    });
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("DELETE /api/tasks/[id]/comments failed:", error);
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }
}

