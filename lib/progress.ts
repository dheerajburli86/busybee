// Progress roll-ups (checklist #11 / #37, SOW #33 / #34).
//
// A subtask's progress is, in order of preference:
//   done                      -> 100
//   a numeric/amount target   -> current / target
//   otherwise                 -> its own percentage
// A task that has subtasks takes the average of them; a task without
// subtasks keeps whatever the assignee reported directly.

export function subtaskPercent(s: {
  done?: boolean | null;
  progress_type?: string | null;
  progress_target?: number | null;
  progress_current?: number | null;
  progress_percent?: number | null;
}): number {
  if (s.done) return 100;
  const target = Number(s.progress_target) || 0;
  if ((s.progress_type === "number" || s.progress_type === "amount") && target > 0) {
    return Math.max(0, Math.min(100, Math.round(((Number(s.progress_current) || 0) / target) * 100)));
  }
  return Math.max(0, Math.min(100, Math.round(Number(s.progress_percent) || 0)));
}

/** Recalculate a task's percentage from its subtasks. Returns the new value, or null if it has none. */
export async function recomputeTaskProgress(supabase: any, taskId: string): Promise<number | null> {
  const { data: subs } = await supabase
    .from("subtasks")
    .select("done, progress_type, progress_target, progress_current, progress_percent")
    .eq("task_id", taskId);

  if (!subs || subs.length === 0) return null;

  const pct = Math.round(subs.reduce((sum: number, s: any) => sum + subtaskPercent(s), 0) / subs.length);
  await supabase
    .from("tasks")
    .update({ progress_percent: pct, updated_at: new Date().toISOString() })
    .eq("id", taskId);
  return pct;
}
