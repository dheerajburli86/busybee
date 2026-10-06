"use client";

// The three steps of the assignment flow that sit either side of the work
// itself: accepting the deadline (before), signing the work off (after), and
// the reward or penalty that may follow the sign-off.
//
// Kept in its own component rather than folded into TaskDetail because each
// panel talks to its own endpoint and appears for a different person: the
// assignee accepts, the supervisor reviews, only an admin or supervisor
// touches money.

import { useCallback, useEffect, useState } from "react";
import { sendJSON } from "@/lib/api";
import { Person, Task, formatDue, nameOf } from "./types";

type Acceptance = {
  user_id: string;
  decision: "accepted" | "declined";
  note: string | null;
  created_at: string;
  due_date_at_decision: string | null;
  stale?: boolean;
};

type AcceptState = {
  expected: string[];
  acceptances: Acceptance[];
  mine: Acceptance | null;
  needs_my_decision: boolean;
  all_accepted: boolean;
};

type Adjustment = {
  id: string;
  user_id: string;
  kind: "reward" | "penalty";
  amount: number;
  reason: string;
  effective_month: string;
  created_by: string | null;
  created_at: string;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
};

const input = "px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm disabled:opacity-50";
const section = "pt-4 mt-4 border-t border-slate-700";
const h4 = "text-sm font-semibold text-slate-300 mb-2";

export function rupees(n: number | string): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "₹0";
  return `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

export function TaskWorkflow({
  task,
  people,
  me,
  canManage,
  isSuper,
  onReplace,
  onError,
  onInfo,
}: {
  task: Task;
  people: Person[];
  me: string | null;
  canManage: boolean;
  isSuper: boolean;
  onReplace: (task: Partial<Task> & { id: string }) => void;
  onError: (msg: string) => void;
  onInfo: (msg: string) => void;
}) {
  const [accept, setAccept] = useState<AcceptState | null>(null);
  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [canAddMoney, setCanAddMoney] = useState(false);
  const [busy, setBusy] = useState("");

  const [declineNote, setDeclineNote] = useState("");
  const [declining, setDeclining] = useState(false);
  const [reviewNote, setReviewNote] = useState("");
  const blankMoney = () => ({
    kind: "reward" as "reward" | "penalty",
    amount: "",
    reason: "",
    // Usually it's about the person who did the work.
    user_id: task.assigned_to && task.assigned_to !== me ? task.assigned_to : "",
  });
  const [money, setMoney] = useState(blankMoney);

  const load = useCallback(async () => {
    try {
      const [a, m] = await Promise.all([
        fetch(`/api/tasks/${task.id}/accept`).then((r) => (r.ok ? r.json() : null)),
        fetch(`/api/tasks/${task.id}/adjustment`).then((r) => (r.ok ? r.json() : null)),
      ]);
      if (a) setAccept(a);
      if (m) {
        setAdjustments(m.entries || []);
        setCanAddMoney(!!m.can_add);
      }
    } catch {
      /* the panels simply don't appear - never block the task view */
    }
  }, [task.id]);

  useEffect(() => {
    load();
  }, [load, task.status, task.due_date, (task as any).review_status]);

  const once = async (key: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy("");
    }
  };

  // ---- step 4: accept the deadline ----------------------------------------
  const decide = (decision: "accepted" | "declined") =>
    once(decision, async () => {
      try {
        await sendJSON(`/api/tasks/${task.id}/accept`, "POST", {
          decision,
          note: decision === "declined" ? declineNote.trim() : undefined,
        });
        setDeclining(false);
        setDeclineNote("");
        onInfo(
          decision === "accepted"
            ? "Deadline accepted."
            : "The assignor has been told. Raise an extension below with the date you need."
        );
        await load();
      } catch (e: any) {
        onError(e.message);
      }
    });

  // ---- step 9: review -----------------------------------------------------
  const review = (decision: "approved" | "sent_back") =>
    once(decision, async () => {
      try {
        const r = await sendJSON(`/api/tasks/${task.id}/review`, "POST", {
          decision,
          note: reviewNote.trim() || undefined,
        });
        setReviewNote("");
        onReplace({ id: task.id, ...r });
        onInfo(decision === "approved" ? "Signed off." : "Sent back to the assignee.");
        await load();
      } catch (e: any) {
        onError(e.message);
      }
    });

  // ---- steps 10-11: reward / penalty --------------------------------------
  const addMoney = () =>
    once("money", async () => {
      try {
        const r = await sendJSON(`/api/tasks/${task.id}/adjustment`, "POST", {
          kind: money.kind,
          amount: Number(money.amount),
          reason: money.reason.trim(),
          user_id: money.user_id,
        });
        setAdjustments((prev) => [r, ...prev]);
        setMoney(blankMoney());
        onInfo(`${money.kind === "reward" ? "Reward" : "Penalty"} recorded. They have been notified.`);
      } catch (e: any) {
        onError(e.message);
      }
    });

  const voidMoney = (a: Adjustment) =>
    once(`void-${a.id}`, async () => {
      const why = window.prompt("Why is this being cancelled? This is kept on the record.");
      if (!why || !why.trim()) return;
      try {
        const r = await sendJSON(`/api/tasks/${task.id}/adjustment`, "DELETE", {
          adjustment_id: a.id,
          void_reason: why.trim(),
        });
        setAdjustments((prev) => prev.map((x) => (x.id === a.id ? { ...x, ...r } : x)));
        onInfo("Cancelled. The entry stays on the record, marked.");
      } catch (e: any) {
        onError(e.message);
      }
    });

  const reviewStatus = (task as any).review_status as string | undefined;
  const awaitingReview = task.status === "done" && reviewStatus === "pending";
  // Nobody signs off their own work, so the person who did it never sees the
  // buttons (the server refuses it regardless).
  const ownWork = !!me && task.assigned_to === me;
  const showReview =
    (canManage && !ownWork && awaitingReview) || reviewStatus === "approved" || reviewStatus === "sent_back";
  const moneyAllowed =
    task.status === "done" ||
    task.status === "closed" ||
    (!!task.due_date && new Date(task.due_date).getTime() < Date.now());
  const showMoney = adjustments.length > 0 || (canAddMoney && moneyAllowed);

  return (
    <>
      {/* ---- Step 4: deadline acceptance ---------------------------------- */}
      {accept && task.due_date && (accept.needs_my_decision || accept.acceptances.length > 0 || accept.expected.length > 0) && (
        <div className={section}>
          <h4 className={h4}>Deadline agreement</h4>

          {accept.needs_my_decision && (
            <div className="bg-blue-950 border border-blue-800 rounded p-3 mb-3">
              <p className="text-sm text-blue-100 mb-3">
                {accept.mine?.stale
                  ? `The deadline moved to ${formatDue(task.due_date)}. Confirm the new date.`
                  : `You've been given this task with a deadline of ${formatDue(task.due_date)}. Can you make it?`}
              </p>
              {!declining ? (
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => decide("accepted")}
                    disabled={!!busy}
                    className="px-4 py-2 bg-green-600 hover:bg-green-500 disabled:opacity-50 rounded text-sm"
                  >
                    Accept deadline
                  </button>
                  <button
                    onClick={() => setDeclining(true)}
                    disabled={!!busy}
                    className="px-4 py-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded text-sm"
                  >
                    I need more time
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  <textarea
                    value={declineNote}
                    onChange={(e) => setDeclineNote(e.target.value)}
                    placeholder="Why doesn't this date work?"
                    rows={2}
                    className={`${input} w-full`}
                  />
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => decide("declined")}
                      disabled={!!busy || !declineNote.trim()}
                      className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 rounded text-sm"
                    >
                      Tell the assignor
                    </button>
                    <button
                      onClick={() => setDeclining(false)}
                      className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded text-sm"
                    >
                      Cancel
                    </button>
                  </div>
                  <p className="text-xs text-slate-400">
                    This flags the date as unworkable. Use "Request extension" below to propose the date you need.
                  </p>
                </div>
              )}
            </div>
          )}

          {accept.expected.length > 0 && (
            <div className="space-y-1">
              {accept.expected.map((uid) => {
                const row = accept.acceptances.find((a) => a.user_id === uid);
                const state = !row || row.stale ? "waiting" : row.decision;
                return (
                  <div key={uid} className="flex items-center justify-between gap-2 text-sm">
                    <span className="text-slate-300">{nameOf(people, uid)}</span>
                    <span
                      className={
                        state === "accepted"
                          ? "text-green-400 text-xs"
                          : state === "declined"
                          ? "text-amber-400 text-xs"
                          : "text-slate-500 text-xs"
                      }
                    >
                      {state === "accepted"
                        ? `accepted ${formatDue(row!.created_at)}`
                        : state === "declined"
                        ? `said it won't work${row!.note ? ` - "${row!.note}"` : ""}`
                        : "not answered yet"}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ---- Step 9: supervisor review ------------------------------------ */}
      {showReview && (
        <div className={section}>
          <h4 className={h4}>Review</h4>

          {reviewStatus === "approved" && (
            <p className="text-sm text-green-400 mb-2">
              Signed off by {nameOf(people, (task as any).reviewed_by)} on {formatDue((task as any).reviewed_at)}
              {(task as any).review_note ? ` - "${(task as any).review_note}"` : ""}
            </p>
          )}
          {reviewStatus === "sent_back" && (
            <p className="text-sm text-amber-400 mb-2">
              Sent back by {nameOf(people, (task as any).reviewed_by)}: "{(task as any).review_note}"
            </p>
          )}

          {awaitingReview && canManage && !ownWork && (
            <div className="bg-slate-900 rounded p-3 space-y-2">
              <p className="text-sm text-slate-300">
                This work is finished and waiting for you. Check it however you normally would - a call, a demo, a
                read-through - then record what you decided.
              </p>
              <textarea
                value={reviewNote}
                onChange={(e) => setReviewNote(e.target.value)}
                placeholder="Notes (required if you're sending it back)"
                rows={2}
                className={`${input} w-full`}
              />
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => review("approved")}
                  disabled={!!busy}
                  className="px-4 py-2 bg-green-600 hover:bg-green-500 disabled:opacity-50 rounded text-sm"
                >
                  Approve &amp; close
                </button>
                <button
                  onClick={() => review("sent_back")}
                  disabled={!!busy || !reviewNote.trim()}
                  className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 rounded text-sm"
                >
                  Send back
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ---- Steps 10-11: reward / penalty -------------------------------- */}
      {showMoney && (
        <div className={section}>
          <h4 className={h4}>Reward or penalty</h4>

          {adjustments.map((a) => (
            <div
              key={a.id}
              className={`bg-slate-900 rounded p-3 mb-2 text-sm ${a.voided_at ? "opacity-60" : ""}`}
            >
              <div className="flex justify-between gap-2">
                <span className={a.kind === "reward" ? "text-green-400" : "text-red-400"}>
                  {a.kind === "reward" ? "Reward" : "Penalty"} {rupees(a.amount)}
                  {a.voided_at && <span className="text-slate-400"> (cancelled)</span>}
                </span>
                <span className="text-slate-500 text-xs shrink-0">{nameOf(people, a.user_id)}</span>
              </div>
              <p className="text-slate-300 mt-1">"{a.reason}"</p>
              <p className="text-slate-500 text-xs mt-1">
                by {nameOf(people, a.created_by)} on {formatDue(a.created_at)} · for{" "}
                {String(a.effective_month).slice(0, 7)}
              </p>
              {a.voided_at && (
                <p className="text-slate-400 text-xs mt-1">
                  Cancelled by {nameOf(people, a.voided_by)}: "{a.void_reason}"
                </p>
              )}
              {isSuper && !a.voided_at && (
                <button
                  onClick={() => voidMoney(a)}
                  disabled={!!busy}
                  className="mt-2 text-xs text-slate-400 hover:text-white underline disabled:opacity-50"
                >
                  Cancel this entry
                </button>
              )}
            </div>
          ))}

          {canAddMoney && moneyAllowed && (
            <div className="bg-slate-900 rounded p-3 space-y-2">
              <div className="flex flex-wrap gap-2">
                <select
                  value={money.kind}
                  onChange={(e) => setMoney({ ...money, kind: e.target.value as "reward" | "penalty" })}
                  className={input}
                  aria-label="Reward or penalty"
                >
                  <option value="reward">Reward</option>
                  <option value="penalty">Penalty</option>
                </select>
                <select
                  value={money.user_id}
                  onChange={(e) => setMoney({ ...money, user_id: e.target.value })}
                  className={`${input} flex-1 min-w-40`}
                  aria-label="Who it applies to"
                >
                  <option value="">Who?</option>
                  {people.filter((p) => p.id !== me).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={money.amount}
                  onChange={(e) => setMoney({ ...money, amount: e.target.value })}
                  placeholder="Amount ₹"
                  className={`${input} w-32`}
                  aria-label="Amount in rupees"
                />
              </div>
              <textarea
                value={money.reason}
                onChange={(e) => setMoney({ ...money, reason: e.target.value })}
                placeholder="Reason - this is shown to them and kept on the record"
                rows={2}
                className={`${input} w-full`}
              />
              <button
                onClick={addMoney}
                disabled={!!busy || !money.user_id || !money.amount || !money.reason.trim()}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm"
              >
                Record it
              </button>
              <p className="text-xs text-slate-500">
                Nothing is paid or deducted here. This goes onto the month's payroll report for finance to apply, and
                the person is told straight away. Entries can be cancelled but never edited or deleted.
              </p>
            </div>
          )}
        </div>
      )}
    </>
  );
}
