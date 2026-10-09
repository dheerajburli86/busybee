// Who hears about what.
//
//   * Everyone gets email and Telegram only about tasks they're part of:
//     given to them, given by them, managing them, or an item on them.
//   * The people marked "oversees" on the desk (People page) hear about
//     everything that happens on every task, in their own words: "Rohit gave
//     Dheeraj a new task...", never "You were assigned...".
// The bell in the app is unchanged: it still shows the usual alerts.

import { TaskCard, dueText } from "@/lib/mailfmt";

/** Everyone who is part of a task. */
export async function involvedIn(db: any, taskId: string): Promise<{ desk_id: string | null; ids: Set<string> }> {
  const ids = new Set<string>();
  try {
    const [{ data: t }, { data: extra }, { data: subs }] = await Promise.all([
      db.from("tasks").select("desk_id, assigned_to, created_by, task_manager_id").eq("id", taskId).maybeSingle(),
      db.from("task_assignors").select("user_id").eq("task_id", taskId),
      db.from("subtasks").select("assigned_to").eq("task_id", taskId),
    ]);
    [t?.assigned_to, t?.created_by, t?.task_manager_id].forEach((x: string | null) => x && ids.add(x));
    (extra || []).forEach((x: any) => x.user_id && ids.add(x.user_id));
    (subs || []).forEach((x: any) => x.assigned_to && ids.add(x.assigned_to));
    return { desk_id: t?.desk_id || null, ids };
  } catch {
    return { desk_id: null, ids };
  }
}

/** The desk's overseers (desk_members.oversees). Empty if the column isn't there yet. */
export async function overseersOf(db: any, deskId: string | null): Promise<string[]> {
  if (!deskId) return [];
  try {
    const { data, error } = await db.from("desk_members").select("user_id").eq("desk_id", deskId).eq("oversees", true);
    if (error) return [];
    return (data || []).map((r: any) => r.user_id);
  } catch {
    return [];
  }
}

/**
 * The same event, told to someone who isn't part of the task: who did what,
 * to whose task. `message` is the original alert, used as detail where it is
 * already written in the third person.
 */
export function overseerWording(
  type: string,
  title: string,
  message: string,
  card: TaskCard | null,
  actor: string | null
): { headline: string; details: string | null } {
  const who = actor || "Someone";
  const doer = card?.assignee || "someone";
  const t = card ? `"${card.title}"` : "a task";
  const whose = card?.assignee ? `${card.assignee}'s task ${t}` : t;
  const due = card ? dueText(card.due) : "";
  switch (type) {
    case "assigned":
      return /list/i.test(title)
        ? { headline: `${who} gave ${doer} a to-do list: ${t}, due ${due}.`, details: null }
        : { headline: `${who} gave ${doer} a new task: ${t}, due ${due}.`, details: null };
    case "deadline_accepted":
      return { headline: `${doer} accepted the deadline for ${t} (${due}).`, details: null };
    case "deadline_declined":
    case "extension_request":
      return { headline: `${who} asked for more time on ${whose}.`, details: message };
    case "extension_reviewed":
      return /reject/i.test(title)
        ? { headline: `${who} turned down ${doer}'s request for more time on ${t}. The deadline stays ${due}.`, details: null }
        : { headline: `${who} gave ${doer} more time on ${t}. The new deadline is ${due}.`, details: null };
    case "deadline_changed":
      return { headline: `${who} moved the deadline of ${whose} to ${due}.`, details: null };
    case "completed":
      return { headline: message, details: null };
    case "review_approved":
      return { headline: `${who} approved ${doer}'s work on ${t} and closed the task.`, details: message };
    case "review_sent_back":
      return { headline: `${who} sent ${doer}'s work on ${t} back for changes.`, details: message };
    case "adjustment_reward":
      return { headline: `${who} gave ${doer} a reward on ${t}.`, details: message };
    case "adjustment_penalty":
      return { headline: `${who} gave ${doer} a penalty on ${t}.`, details: message };
    case "adjustment_voided":
      return { headline: `${who} cancelled a reward or penalty on ${whose}.`, details: message };
    case "mention":
      return { headline: `${who} commented on ${whose}.`, details: message };
    case "updated":
      return { headline: `${who} changed ${whose}.`, details: message };
    case "subtask_completed":
      return { headline: `${who} ticked off an item on ${whose}.`, details: message };
    case "assignor_added":
      return { headline: `${who} added a person who can manage ${whose}.`, details: message };
    default:
      return { headline: `Update on ${whose}${actor ? ` from ${actor}` : ""}: ${title}.`, details: null };
  }
}
