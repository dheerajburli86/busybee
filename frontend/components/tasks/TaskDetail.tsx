"use client";

// Everything about one task in a single panel: fields, progress, subtasks
// (the task's checklist), dependencies, assignors, files, comments, deadline
// extensions and the task's history. Which controls appear depends on what
// the server says this person may do; the server re-checks every change.

import { useCallback, useEffect, useState } from "react";
import { sendJSON } from "@/lib/api";
import { createClient } from "@/lib/supabase";
import { STATUSES, isFinished, isOverdue, statusClass, statusLabel } from "@/lib/status";
import {
  Lookups,
  MILESTONES,
  PRIORITIES,
  Task,
  formatDue,
  fromLocalInput,
  nameOf,
  sectionsFor,
  toLocalInput,
} from "./types";
import { MentionTextarea } from "./MentionTextarea";

type Access = { canManage: boolean; canWork: boolean; isSuper: boolean; role: string };
type Comment = {
  id: string;
  content: string;
  author_id: string;
  author_name?: string;
  created_at: string;
  edited?: boolean;
  is_private?: boolean;
  recipients?: string[];
  recipient_names?: string[];
};
type Attachment = {
  id: string;
  file_name: string;
  file_size: number | null;
  visibility: string;
  uploaded_by: string | null;
  uploader_name?: string;
  created_at: string;
  download_url: string;
  can_manage: boolean;
  shared_with?: string[];
};
type Subtask = {
  id: string;
  title: string;
  done: boolean;
  progress_percent: number | null;
  position: number | null;
  assigned_to: string | null;
  due_date: string | null;
  progress_type: string | null;
  progress_target: number | null;
  progress_current: number | null;
  created_by: string | null;
};
type Activity = { id: string; action: string; user_name?: string; created_at: string; changes: any; names?: Record<string, string> };
type Extension = {
  id: string;
  reason: string;
  requested_date: string;
  status: string;
  approved_date: string | null;
  review_note: string | null;
  requested_by: string;
  created_at: string;
  can_review: boolean;
};

const input = "px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm disabled:opacity-50";
const section = "pt-4 mt-4 border-t border-slate-700";
const h4 = "text-sm font-semibold text-slate-300 mb-2";

function fmtSize(n: number | null) {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const FIELD_LABELS: Record<string, string> = {
  stage_id: "section",
  project_id: "project",
  assigned_to: "assignee",
  task_manager_id: "task manager",
  key_result_id: "OKR link",
  team_id: "team",
  department_id: "department",
  group_id: "group",
  due_date: "due date",
  start_date: "start date",
  progress_percent: "progress",
  archived_at: "archived",
  remind_at: "reminder",
};
const fieldLabel = (k: string) => FIELD_LABELS[k] || k.replace(/_/g, " ");

function describeChange(v: any): string {
  if (v === null || v === undefined || v === "") return "none";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return formatDue(v);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function TaskDetail({
  task,
  allTasks,
  lookups,
  onClose,
  onPatch,
  onReplace,
  onAdd,
  onError,
  onInfo,
}: {
  task: Task;
  allTasks: Task[];
  lookups: Lookups;
  onClose: () => void;
  onPatch: (id: string, patch: Partial<Task>) => Promise<boolean>;
  onReplace: (task: Partial<Task> & { id: string }) => void;
  onAdd: (task: Task) => void;
  onError: (msg: string) => void;
  onInfo: (msg: string) => void;
}) {
  const [access, setAccess] = useState<Access | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [subtasks, setSubtasks] = useState<Subtask[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [deps, setDeps] = useState<string[]>([]);
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [assignors, setAssignors] = useState<{ id: string; user_id: string }[]>([]);
  const [tab, setTab] = useState<"details" | "files" | "comments" | "history">("details");

  const [newComment, setNewComment] = useState("");
  // #31: a comment can go privately to chosen people.
  const [privateTo, setPrivateTo] = useState<string[] | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [newSub, setNewSub] = useState({ title: "", due: "", assignee: "" });
  const [ext, setExt] = useState({ reason: "", date: "" });
  const [amend, setAmend] = useState<Record<string, { date: string; note: string }>>({});
  const [upload, setUpload] = useState({ visibility: "all", shared: [] as string[], busy: false });
  const [shareEdit, setShareEdit] = useState<string | null>(null);

  const people = lookups.people;
  const me = lookups.me;

  const load = useCallback(async () => {
    const get = async (url: string) => {
      const r = await fetch(url, { cache: "no-store" });
      return r.ok ? r.json() : null;
    };
    try {
      const [a, c, f, s, h, d, x, g] = await Promise.all([
        get(`/api/tasks/${task.id}/access`),
        get(`/api/tasks/${task.id}/comments`),
        get(`/api/tasks/${task.id}/attachments`),
        get(`/api/tasks/${task.id}/subtasks`),
        get(`/api/tasks/${task.id}/activity`),
        get(`/api/tasks/${task.id}/dependencies`),
        get(`/api/tasks/${task.id}/extension`),
        get(`/api/tasks/${task.id}/assignors`),
      ]);
      setAccess(a || { canManage: false, canWork: false, isSuper: false, role: "member" });
      setComments(c || []);
      setAttachments(f || []);
      setSubtasks(s || []);
      setActivity(h || []);
      setDeps((d || []).map((r: any) => r.depends_on_task_id));
      setExtensions(x || []);
      setAssignors(g || []);
    } catch {
      onError("Could not load task details");
    }
  }, [task.id, onError]);

  useEffect(() => {
    load();
  }, [load]);

  const refreshHistory = async () => {
    const r = await fetch(`/api/tasks/${task.id}/activity`, { cache: "no-store" });
    if (r.ok) setActivity(await r.json());
  };

  const patch = async (p: Partial<Task>) => {
    const ok = await onPatch(task.id, p);
    if (ok) refreshHistory();
  };

  const canManage = !!access?.canManage;
  const canWork = !!access?.canWork;
  const hasSubtasks = subtasks.length > 0;
  const overdue = isOverdue(task);

  const applyTaskProgress = (pct: number | null | undefined, updated?: Task | null) => {
    // #20: finishing the checklist may have completed the task (and moved it on).
    if (updated) {
      onReplace({ ...updated, subtask_count: subtasks.length });
      onInfo("Every checklist item is done, so the task was marked Completed.");
      return;
    }
    if (pct !== null && pct !== undefined) onReplace({ id: task.id, progress_percent: pct, subtask_count: subtasks.length });
  };

  // ---- subtasks -----------------------------------------------------------
  const saveSubtask = async (st: Subtask, p: Partial<Subtask>) => {
    const before = st;
    setSubtasks((prev) => prev.map((x) => (x.id === st.id ? { ...x, ...p } : x)));
    try {
      const res = await sendJSON(`/api/tasks/${task.id}/subtasks`, "PUT", { subtask_id: st.id, ...p });
      const { task: updated, task_progress, ...row } = res;
      setSubtasks((prev) => prev.map((x) => (x.id === st.id ? { ...x, ...row } : x)));
      applyTaskProgress(task_progress, updated);
      refreshHistory();
    } catch (e: any) {
      setSubtasks((prev) => prev.map((x) => (x.id === st.id ? before : x)));
      onError(e.message);
    }
  };

  const addSubtask = async () => {
    if (!newSub.title.trim()) return;
    try {
      const res = await sendJSON(`/api/tasks/${task.id}/subtasks`, "POST", {
        title: newSub.title.trim(),
        due_date: fromLocalInput(newSub.due),
        assigned_to: newSub.assignee || null,
      });
      setSubtasks((prev) => [...prev, res]);
      applyTaskProgress(res.task_progress);
      onReplace({ id: task.id, subtask_count: subtasks.length + 1 });
      setNewSub({ title: "", due: "", assignee: "" });
      refreshHistory();
    } catch (e: any) {
      onError(e.message);
    }
  };

  const removeSubtask = async (st: Subtask) => {
    setSubtasks((prev) => prev.filter((x) => x.id !== st.id));
    try {
      const res = await sendJSON(`/api/tasks/${task.id}/subtasks`, "DELETE", { subtask_id: st.id });
      applyTaskProgress(res.task_progress, res.task);
      onReplace({ id: task.id, subtask_count: subtasks.length - 1 });
      refreshHistory();
    } catch (e: any) {
      setSubtasks((prev) => [...prev, st].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)));
      onError(e.message);
    }
  };

  // ---- comments -----------------------------------------------------------
  const postComment = async () => {
    if (!newComment.trim()) return;
    if (privateTo && privateTo.length === 0) return onError("Pick who should see this private comment.");
    try {
      const c = await sendJSON(`/api/tasks/${task.id}/comments`, "POST", {
        content: newComment.trim(),
        ...(privateTo ? { private_to: privateTo } : {}),
      });
      setComments((prev) => [c, ...prev]);
      setNewComment("");
      setPrivateTo(null);
      refreshHistory();
    } catch (e: any) {
      onError(e.message);
    }
  };

  const saveEdit = async () => {
    if (!editing || !editing.text.trim()) return;
    try {
      const c = await sendJSON(`/api/tasks/${task.id}/comments`, "PUT", { comment_id: editing.id, content: editing.text.trim() });
      setComments((prev) => prev.map((x) => (x.id === c.id ? c : x)));
      setEditing(null);
    } catch (e: any) {
      onError(e.message);
    }
  };

  const deleteComment = async (c: Comment) => {
    if (!confirm("Delete this comment?")) return;
    try {
      await sendJSON(`/api/tasks/${task.id}/comments`, "DELETE", { comment_id: c.id });
      setComments((prev) => prev.filter((x) => x.id !== c.id));
      refreshHistory();
    } catch (e: any) {
      onError(e.message);
    }
  };

  // ---- files --------------------------------------------------------------
  const uploadFile = async (file: File) => {
    if (file.size > 25 * 1024 * 1024) return onError("That file is larger than 25 MB.");
    setUpload((u) => ({ ...u, busy: true }));
    try {
      // The file goes straight to storage through a one-time link (the app's
      // own servers only accept small requests), then gets recorded here.
      const { path, token } = await sendJSON(`/api/tasks/${task.id}/attachments/upload`, "POST", {
        file_name: file.name,
        file_size: file.size,
      });
      const { error } = await createClient()
        .storage.from("task-files")
        .uploadToSignedUrl(path, token, file, { contentType: file.type || "application/octet-stream" });
      if (error) throw new Error(error.message || "Upload failed");
      const data = await sendJSON(`/api/tasks/${task.id}/attachments`, "POST", {
        storage_path: path,
        file_name: file.name,
        file_size: file.size,
        file_type: file.type || null,
        visibility: upload.visibility,
        shared_with: upload.visibility === "custom" ? upload.shared : [],
      });
      setAttachments((prev) => [data, ...prev]);
      refreshHistory();
    } catch (e: any) {
      onError(e.message);
    } finally {
      setUpload((u) => ({ ...u, busy: false }));
    }
  };

  const setFileAccess = async (a: Attachment, visibility: string, shared: string[] = a.shared_with || []) => {
    try {
      const data = await sendJSON(`/api/tasks/${task.id}/attachments`, "PUT", {
        attachment_id: a.id,
        visibility,
        shared_with: shared,
      });
      setAttachments((prev) => prev.map((x) => (x.id === a.id ? data : x)));
      refreshHistory();
    } catch (e: any) {
      onError(e.message);
    }
  };

  const deleteFile = async (a: Attachment) => {
    if (!confirm(`Delete ${a.file_name}?`)) return;
    try {
      await sendJSON(`/api/tasks/${task.id}/attachments`, "DELETE", { attachment_id: a.id });
      setAttachments((prev) => prev.filter((x) => x.id !== a.id));
      refreshHistory();
    } catch (e: any) {
      onError(e.message);
    }
  };

  // ---- extensions ---------------------------------------------------------
  const requestExtension = async () => {
    const iso = fromLocalInput(ext.date);
    if (!ext.reason.trim() || !iso) return onError("Give a reason and a new date and time");
    try {
      const r = await sendJSON(`/api/tasks/${task.id}/extension`, "POST", { reason: ext.reason.trim(), requested_date: iso });
      setExtensions((prev) => [r, ...prev]);
      setExt({ reason: "", date: "" });
      onInfo("Extension request sent to the assignor.");
      refreshHistory();
    } catch (e: any) {
      onError(e.message);
    }
  };

  const decide = async (x: Extension, status: "approved" | "rejected", withDate?: string) => {
    const a = amend[x.id] || { date: "", note: "" };
    const approved_date = withDate ? fromLocalInput(withDate) : undefined;
    if (withDate && !approved_date) return onError("Pick the new date and time");
    try {
      const r = await sendJSON(`/api/tasks/${task.id}/extension`, "PUT", {
        request_id: x.id,
        status,
        approved_date,
        review_note: a.note || undefined,
      });
      setExtensions((prev) => prev.map((e) => (e.id === x.id ? { ...e, ...r } : e)));
      if (r.task_due_date) onReplace({ id: task.id, due_date: r.task_due_date });
      refreshHistory();
    } catch (e: any) {
      onError(e.message);
    }
  };

  // ---- header actions -----------------------------------------------------
  const duplicate = async (projectId?: string) => {
    try {
      const r = await sendJSON(`/api/tasks/${task.id}/duplicate`, "POST", { project_id: projectId || null });
      onAdd(r.task);
      onInfo(projectId ? "Copied into the other project." : "Task duplicated.");
    } catch (e: any) {
      onError(e.message);
    }
  };

  const remind = async (kind: "reminder" | "update_request") => {
    try {
      await sendJSON(`/api/tasks/${task.id}/remind`, "POST", { kind });
      onInfo(kind === "reminder" ? "Reminder sent to the assignee." : "Update request sent to the assignee.");
      refreshHistory();
    } catch (e: any) {
      onError(e.message);
    }
  };

  const saveTemplate = async () => {
    try {
      await sendJSON("/api/templates", "POST", { from_task_id: task.id });
      onInfo("Saved as a template.");
    } catch (e: any) {
      onError(e.message);
    }
  };

  const actionBtn = "px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded text-sm";
  const assignorIds = [task.created_by, ...assignors.map((a) => a.user_id)].filter(Boolean) as string[];

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-stretch sm:items-center justify-center sm:p-4" onClick={onClose}>
      <div
        className="bg-slate-800 sm:rounded border border-slate-700 w-full max-w-3xl h-full sm:h-auto sm:max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={task.title}
      >
        {/* Header */}
        <div className="sticky top-0 bg-slate-800 border-b border-slate-700 p-4 z-10">
          <div className="flex justify-between items-start gap-3">
            <div className="min-w-0">
              <h2 className={`text-xl font-bold break-words ${overdue ? "text-red-400" : ""}`}>
                {task.title}
                {overdue && <span className="ml-2 text-xs align-middle text-red-400">OVERDUE</span>}
                {task.archived_at && <span className="ml-2 text-xs align-middle text-slate-400">ARCHIVED</span>}
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                Created by {nameOf(people, task.created_by, "someone")} · {new Date(task.created_at).toLocaleDateString()}
                {task.completed_at && ` · finished ${formatDue(task.completed_at)}`}
              </p>
            </div>
            <button onClick={onClose} className="text-slate-400 hover:text-white text-xl px-2" aria-label="Close">
              ✕
            </button>
          </div>

          <div className="flex flex-wrap gap-2 mt-3">
            <button onClick={() => duplicate()} className={actionBtn}>📋 Duplicate</button>
            {lookups.projects.length > 1 && (
              <select value="" onChange={(e) => e.target.value && duplicate(e.target.value)} className={input}>
                <option value="">Copy to project...</option>
                {lookups.projects.filter((p) => p.id !== task.project_id).map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            )}
            {canManage && <button onClick={() => remind("update_request")} className={actionBtn}>🔔 Request update</button>}
            {canManage && <button onClick={() => remind("reminder")} className={actionBtn}>⏰ Remind</button>}
            <button onClick={saveTemplate} className={actionBtn}>📄 Save as template</button>
            {/* A completed task can be re-opened (from the archive too). */}
            {isFinished(task.status) && canWork && (!task.archived_at || canManage) && (
              <button
                onClick={async () => {
                  const ok = await onPatch(task.id, { status: "in_progress", ...(task.archived_at ? { archived_at: null } : {}) });
                  if (ok) {
                    onInfo("Task re-opened.");
                    refreshHistory();
                  }
                }}
                className={actionBtn}
              >
                ↩️ Re-open
              </button>
            )}
            {canManage && (
              <button
                onClick={async () => {
                  const ok = await onPatch(task.id, { archived_at: task.archived_at ? null : new Date().toISOString() });
                  if (ok) {
                    onInfo(task.archived_at ? "Task restored." : "Task archived. Find it under Archive.");
                    onClose();
                  }
                }}
                className={actionBtn}
              >
                {task.archived_at ? "♻️ Restore" : "🗄️ Archive"}
              </button>
            )}
          </div>

          <div className="flex gap-1 mt-3 text-sm overflow-x-auto">
            {(
              [
                ["details", "Details"],
                ["files", `Files (${attachments.length})`],
                ["comments", `Comments (${comments.length})`],
                ["history", `History (${activity.length})`],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={`px-3 py-1.5 rounded whitespace-nowrap ${tab === k ? "bg-blue-600 text-white" : "bg-slate-900 text-slate-300"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="p-4">
          {!access && <p className="text-slate-400 text-sm">Loading...</p>}

          {access && tab === "details" && (
            <>
              {task.description && <p className="text-slate-300 text-sm whitespace-pre-wrap mb-4">{task.description}</p>}
              {!canWork && (
                <p className="text-xs text-slate-400 mb-3">You can view this task but aren't working on it, so the controls are read-only.</p>
              )}

              {/* Core fields */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                <label className="flex flex-col gap-1">
                  <span className="text-slate-400 text-xs">Status</span>
                  <select value={task.status} disabled={!canWork} onChange={(e) => patch({ status: e.target.value })} className={input}>
                    {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-slate-400 text-xs">Priority</span>
                  <select value={task.priority} disabled={!canManage} onChange={(e) => patch({ priority: e.target.value })} className={input}>
                    {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-slate-400 text-xs">Start</span>
                  <input
                    type="datetime-local"
                    value={toLocalInput(task.start_date)}
                    disabled={!canManage}
                    onChange={(e) => patch({ start_date: fromLocalInput(e.target.value) })}
                    className={input}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-slate-400 text-xs">Due {canManage ? "" : "(ask for an extension to change)"}</span>
                  <input
                    type="datetime-local"
                    value={toLocalInput(task.due_date)}
                    disabled={!canManage}
                    onChange={(e) => {
                      const iso = fromLocalInput(e.target.value);
                      if (iso) patch({ due_date: iso });
                    }}
                    className={input}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-slate-400 text-xs">Project</span>
                  <select value={task.project_id || ""} disabled={!canManage} onChange={(e) => e.target.value && patch({ project_id: e.target.value })} className={input}>
                    {lookups.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </label>
                {sectionsFor(lookups.projects, task.project_id).length > 0 && (
                  <label className="flex flex-col gap-1">
                    <span className="text-slate-400 text-xs">Section</span>
                    <select value={task.stage_id || ""} disabled={!canManage} onChange={(e) => e.target.value && patch({ stage_id: e.target.value })} className={input} aria-label="Section">
                      {!task.stage_id && <option value="">None</option>}
                      {sectionsFor(lookups.projects, task.project_id).map((sec) => <option key={sec.id} value={sec.id}>{sec.name}</option>)}
                    </select>
                  </label>
                )}
                <label className="flex flex-col gap-1">
                  <span className="text-slate-400 text-xs">Remind me at {task.remind_at && !canWork ? "" : "(optional)"}</span>
                  <div className="flex gap-2">
                    <input
                      type="datetime-local"
                      value={toLocalInput(task.remind_at)}
                      disabled={!canWork}
                      onChange={(e) => patch({ remind_at: fromLocalInput(e.target.value) })}
                      className={`${input} flex-1 min-w-0`}
                      aria-label="Reminder"
                    />
                    {task.remind_at && canWork && (
                      <button onClick={() => patch({ remind_at: null })} className="text-xs text-slate-400 hover:text-white px-2" aria-label="Clear reminder">✕</button>
                    )}
                  </div>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-slate-400 text-xs">Milestone</span>
                  <select value={task.milestone || ""} disabled={!canManage} onChange={(e) => patch({ milestone: e.target.value || null })} className={input}>
                    <option value="">None</option>
                    {MILESTONES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                    {task.milestone && !MILESTONES.some((m) => m.value === task.milestone) && (
                      <option value={task.milestone}>{task.milestone}</option>
                    )}
                  </select>
                </label>
              </div>

              {/* Assignment (checklist #4): person, team, department, custom group */}
              <div className={section}>
                <h4 className={h4}>Assigned to</h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                  <label className="flex flex-col gap-1">
                    <span className="text-slate-400 text-xs">Person</span>
                    <select value={task.assigned_to || ""} disabled={!canManage} onChange={(e) => patch({ assigned_to: e.target.value || null })} className={input}>
                      <option value="">Nobody</option>
                      {people.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-slate-400 text-xs">Team</span>
                    <select value={task.team_id || ""} disabled={!canManage} onChange={(e) => patch({ team_id: e.target.value || null })} className={input}>
                      <option value="">No team</option>
                      {lookups.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-slate-400 text-xs">Department</span>
                    <select value={task.department_id || ""} disabled={!canManage} onChange={(e) => patch({ department_id: e.target.value || null })} className={input}>
                      <option value="">No department</option>
                      {lookups.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-slate-400 text-xs">Custom group</span>
                    <select value={task.group_id || ""} disabled={!canManage} onChange={(e) => patch({ group_id: e.target.value || null })} className={input}>
                      <option value="">No group</option>
                      {lookups.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-slate-400 text-xs">Task manager</span>
                    <select value={task.task_manager_id || ""} disabled={!canManage} onChange={(e) => patch({ task_manager_id: e.target.value || null })} className={input}>
                      <option value="">None</option>
                      {people.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-slate-400 text-xs">OKR key result</span>
                    <select value={task.key_result_id || ""} disabled={!canManage} onChange={(e) => patch({ key_result_id: e.target.value || null })} className={input}>
                      <option value="">Not linked</option>
                      {lookups.keyResults.map((k) => <option key={k.id} value={k.id}>{k.title}</option>)}
                    </select>
                  </label>
                </div>
              </div>

              {/* Progress (checklist #11 / #37) */}
              <div className={section}>
                <h4 className={h4}>Progress: {task.progress_percent}%</h4>
                <div className="w-full bg-slate-900 rounded h-2 mb-3">
                  <div className="bg-blue-600 h-2 rounded" style={{ width: `${task.progress_percent}%` }} />
                </div>
                {hasSubtasks ? (
                  <p className="text-xs text-slate-400">Calculated from the {subtasks.length} subtasks below.</p>
                ) : (
                  <div className="flex flex-wrap gap-2 items-center text-sm">
                    <select
                      value={task.progress_type || "percent"}
                      disabled={!canManage}
                      onChange={(e) => patch({ progress_type: e.target.value })}
                      className={input}
                    >
                      <option value="percent">Percentage</option>
                      <option value="number">Number of units</option>
                      <option value="amount">Amount</option>
                    </select>
                    {task.progress_type === "number" || task.progress_type === "amount" ? (
                      <>
                        <input
                          key={`cur-${task.progress_current}`}
                          type="number" min="0" disabled={!canWork}
                          defaultValue={task.progress_current ?? 0}
                          onBlur={(e) => Number(e.target.value) !== Number(task.progress_current ?? 0) && patch({ progress_current: Number(e.target.value) })}
                          className={`${input} w-24`} aria-label="Done so far"
                        />
                        <span className="text-slate-400">of</span>
                        <input
                          key={`tgt-${task.progress_target}`}
                          type="number" min="0" disabled={!canManage}
                          defaultValue={task.progress_target ?? 0}
                          onBlur={(e) => Number(e.target.value) !== Number(task.progress_target ?? 0) && patch({ progress_target: Number(e.target.value) })}
                          className={`${input} w-24`} aria-label="Target"
                        />
                        <span className="text-xs text-slate-500">{task.progress_type === "amount" ? "amount" : "units"}</span>
                      </>
                    ) : (
                      <input
                        key={`pct-${task.progress_percent}`}
                        type="range" min={0} max={100} step={5} disabled={!canWork}
                        defaultValue={task.progress_percent}
                        onMouseUp={(e) => patch({ progress_percent: Number((e.target as HTMLInputElement).value) })}
                        onTouchEnd={(e) => patch({ progress_percent: Number((e.target as HTMLInputElement).value) })}
                        onKeyUp={(e) => patch({ progress_percent: Number((e.target as HTMLInputElement).value) })}
                        className="flex-1 min-w-40" aria-label="Progress"
                      />
                    )}
                  </div>
                )}
              </div>

              {/* Subtasks = checklist with deadlines and quantities */}
              <div className={section}>
                <h4 className={h4}>
                  Subtasks / checklist ({subtasks.filter((s) => s.done).length} done, {subtasks.filter((s) => !s.done).length} left)
                </h4>
                <div className="space-y-2">
                  {subtasks.map((st) => {
                    const mine = st.assigned_to === me;
                    const can = canWork || mine;
                    const quantified = st.progress_type === "number" || st.progress_type === "amount";
                    const late = st.due_date && !st.done && new Date(st.due_date) < new Date();
                    return (
                      <div key={st.id} className="bg-slate-900 rounded p-3 text-sm">
                        <div className="flex items-start gap-2">
                          <input type="checkbox" checked={st.done} disabled={!can} onChange={() => saveSubtask(st, { done: !st.done })} className="mt-1" aria-label="Done" />
                          <div className="flex-1 min-w-0">
                            <p className={st.done ? "line-through text-slate-500" : "text-slate-200"}>{st.title}</p>
                            <p className={`text-xs mt-0.5 ${late ? "text-red-400" : "text-slate-500"}`}>
                              {nameOf(people, st.assigned_to)}
                              {st.due_date && ` · due ${formatDue(st.due_date)}${late ? " (late)" : ""}`}
                            </p>
                          </div>
                          {(canManage || st.created_by === me) && (
                            <button onClick={() => removeSubtask(st)} className="text-slate-500 hover:text-red-400 text-xs px-1" aria-label="Remove subtask">✕</button>
                          )}
                        </div>
                        {can && (
                          <div className="flex flex-wrap gap-2 mt-2 items-center">
                            <select value={st.assigned_to || ""} onChange={(e) => saveSubtask(st, { assigned_to: e.target.value || null })} className={`${input} text-xs py-1`} aria-label="Subtask assignee">
                              <option value="">Unassigned</option>
                              {people.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                            </select>
                            <input
                              type="datetime-local"
                              value={toLocalInput(st.due_date)}
                              onChange={(e) => saveSubtask(st, { due_date: fromLocalInput(e.target.value) })}
                              className={`${input} text-xs py-1`} aria-label="Subtask deadline"
                            />
                            <select value={st.progress_type || "percent"} onChange={(e) => saveSubtask(st, { progress_type: e.target.value })} className={`${input} text-xs py-1`} aria-label="Measure by">
                              <option value="percent">%</option>
                              <option value="number">Units</option>
                              <option value="amount">Amount</option>
                            </select>
                            {quantified ? (
                              <>
                                <input type="number" min="0" defaultValue={st.progress_current ?? 0}
                                  onBlur={(e) => saveSubtask(st, { progress_current: Number(e.target.value) })}
                                  className={`${input} text-xs py-1 w-20`} aria-label="Done so far" />
                                <span className="text-xs text-slate-500">of</span>
                                <input type="number" min="0" defaultValue={st.progress_target ?? 0}
                                  onBlur={(e) => saveSubtask(st, { progress_target: Number(e.target.value) })}
                                  className={`${input} text-xs py-1 w-20`} aria-label="Target" />
                              </>
                            ) : (
                              <input type="range" min={0} max={100} step={5} defaultValue={st.done ? 100 : st.progress_percent ?? 0}
                                onMouseUp={(e) => saveSubtask(st, { progress_percent: Number((e.target as HTMLInputElement).value) })}
                                onTouchEnd={(e) => saveSubtask(st, { progress_percent: Number((e.target as HTMLInputElement).value) })}
                                className="flex-1 min-w-24" aria-label="Subtask progress" />
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                {canWork && (
                  <div className="flex flex-wrap gap-2 mt-3">
                    <input value={newSub.title} onChange={(e) => setNewSub({ ...newSub, title: e.target.value })}
                      onKeyDown={(e) => e.key === "Enter" && addSubtask()}
                      placeholder="Add a subtask or checklist item..." className={`${input} flex-1 min-w-48`} />
                    <input type="datetime-local" value={newSub.due} onChange={(e) => setNewSub({ ...newSub, due: e.target.value })} className={input} aria-label="Deadline" />
                    <select value={newSub.assignee} onChange={(e) => setNewSub({ ...newSub, assignee: e.target.value })} className={input} aria-label="Assign to">
                      <option value="">Unassigned</option>
                      {people.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                    <button onClick={addSubtask} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm">Add</button>
                  </div>
                )}
              </div>

              {/* Deadline extension (checklist #43 / #44) */}
              {(canWork || extensions.length > 0) && (
                <div className={section}>
                  <h4 className={h4}>Deadline extension</h4>
                  {extensions.map((x) => (
                    <div key={x.id} className="bg-slate-900 rounded p-3 mb-2 text-sm">
                      <div className="flex justify-between gap-2">
                        <span className="text-slate-300">"{x.reason}"</span>
                        <span className={`text-xs shrink-0 ${x.status === "approved" ? "text-green-400" : x.status === "rejected" ? "text-red-400" : "text-yellow-400"}`}>
                          {x.status}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 mt-1">
                        {nameOf(people, x.requested_by, "Someone")} asked for {formatDue(x.requested_date)}
                        {x.approved_date && ` · granted ${formatDue(x.approved_date)}`}
                        {x.review_note && ` · note: ${x.review_note}`}
                      </p>
                      {x.can_review && (
                        <div className="mt-2 space-y-2">
                          <div className="flex flex-wrap gap-2">
                            <button onClick={() => decide(x, "approved")} className="px-3 py-1.5 bg-green-700 hover:bg-green-600 rounded text-xs">Approve as asked</button>
                            <button onClick={() => decide(x, "rejected")} className="px-3 py-1.5 bg-slate-600 hover:bg-slate-500 rounded text-xs">Reject</button>
                          </div>
                          <div className="flex flex-wrap gap-2 items-center">
                            <input type="datetime-local" value={amend[x.id]?.date || ""}
                              onChange={(e) => setAmend({ ...amend, [x.id]: { ...(amend[x.id] || { note: "" }), date: e.target.value } })}
                              className={`${input} text-xs py-1`} aria-label="Different deadline" />
                            <button onClick={() => decide(x, "approved", amend[x.id]?.date)} disabled={!amend[x.id]?.date}
                              className="px-3 py-1.5 bg-blue-700 hover:bg-blue-600 disabled:opacity-40 rounded text-xs">Approve with this date</button>
                          </div>
                          <input value={amend[x.id]?.note || ""}
                            onChange={(e) => setAmend({ ...amend, [x.id]: { ...(amend[x.id] || { date: "" }), note: e.target.value } })}
                            placeholder="Note to the requester (optional)" className={`${input} text-xs py-1 w-full`} />
                        </div>
                      )}
                    </div>
                  ))}
                  {canWork && !extensions.some((x) => x.status === "pending") && (
                    <div className="space-y-2">
                      {overdue && <p className="text-xs text-red-400">This task is overdue - give a reason for the delay.</p>}
                      <input value={ext.reason} onChange={(e) => setExt({ ...ext, reason: e.target.value })}
                        placeholder="Reason for the delay..." className={`${input} w-full`} />
                      <div className="flex flex-wrap gap-2">
                        <input type="datetime-local" value={ext.date} onChange={(e) => setExt({ ...ext, date: e.target.value })} className={input} aria-label="Requested deadline" />
                        <button onClick={requestExtension} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm">Request extension</button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Dependencies */}
              <div className={section}>
                <h4 className={h4}>Depends on</h4>
                {deps.length === 0 && <p className="text-sm text-slate-500 mb-2">Nothing</p>}
                {deps.map((id) => {
                  const d = allTasks.find((t) => t.id === id);
                  return (
                    <div key={id} className="bg-slate-900 px-3 py-2 rounded text-sm flex justify-between items-center gap-2 mb-1">
                      <span>
                        🔗 {d ? d.title : "A task you can't see"}
                        {d && <span className={`ml-2 text-xs px-1.5 rounded ${statusClass(d.status)}`}>{statusLabel(d.status)}</span>}
                      </span>
                      {canManage && (
                        <button
                          onClick={async () => {
                            try {
                              await sendJSON(`/api/tasks/${task.id}/dependencies`, "DELETE", { depends_on_task_id: id });
                              setDeps((p) => p.filter((x) => x !== id));
                            } catch (e: any) { onError(e.message); }
                          }}
                          className="text-slate-500 hover:text-red-400 text-xs" aria-label="Remove dependency"
                        >✕</button>
                      )}
                    </div>
                  );
                })}
                {canManage && (
                  <select value="" className={`${input} w-full mt-1`}
                    onChange={async (e) => {
                      const id = e.target.value;
                      if (!id) return;
                      try {
                        await sendJSON(`/api/tasks/${task.id}/dependencies`, "POST", { depends_on_task_id: id });
                        setDeps((p) => [...p, id]);
                      } catch (err: any) { onError(err.message); }
                    }}>
                    <option value="">+ Add a dependency...</option>
                    {allTasks.filter((t) => t.id !== task.id && !deps.includes(t.id)).map((t) => (
                      <option key={t.id} value={t.id}>{t.title}</option>
                    ))}
                  </select>
                )}
              </div>

              {/* Assignors (SOW #44) */}
              <div className={section}>
                <h4 className={h4}>Assignors ({assignorIds.length})</h4>
                <div className="flex flex-wrap gap-2">
                  <span className="px-2 py-1 bg-slate-700 rounded text-xs">{nameOf(people, task.created_by, "Creator")} <span className="text-slate-400">(created)</span></span>
                  {assignors.map((x) => (
                    <span key={x.id} className="px-2 py-1 bg-slate-700 rounded text-xs flex items-center gap-2">
                      {nameOf(people, x.user_id, "Someone")}
                      {(canManage || x.user_id === me) && (
                        <button
                          onClick={async () => {
                            try {
                              await sendJSON(`/api/tasks/${task.id}/assignors`, "DELETE", { user_id: x.user_id });
                              setAssignors((p) => p.filter((y) => y.id !== x.id));
                            } catch (e: any) { onError(e.message); }
                          }}
                          className="text-slate-400 hover:text-red-400" aria-label="Remove assignor"
                        >✕</button>
                      )}
                    </span>
                  ))}
                </div>
                {canManage && (
                  <select value="" className={`${input} mt-2`}
                    onChange={async (e) => {
                      const uid = e.target.value;
                      if (!uid) return;
                      try {
                        const added = await sendJSON(`/api/tasks/${task.id}/assignors`, "POST", { user_id: uid });
                        setAssignors((p) => [...p, added]);
                      } catch (err: any) { onError(err.message); }
                    }}>
                    <option value="">Add an assignor...</option>
                    {people.filter((m) => !assignorIds.includes(m.id)).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                )}
              </div>
            </>
          )}

          {/* Files (checklist #32 / #33 / #47) */}
          {access && tab === "files" && (
            <>
              {canWork && (
                <div className="bg-slate-900 rounded p-3 mb-4 text-sm space-y-2">
                  <div className="flex flex-wrap gap-2 items-center">
                    <select value={upload.visibility} onChange={(e) => setUpload({ ...upload, visibility: e.target.value })} className={input} aria-label="Who can open it">
                      <option value="all">Everyone on the task</option>
                      <option value="restricted">Restricted (assignor, assignee, supervisors)</option>
                      <option value="custom">Restricted + people I choose</option>
                    </select>
                    <label className="inline-block">
                      <input type="file" className="hidden" disabled={upload.busy}
                        onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadFile(f); e.target.value = ""; }} />
                      <span className="bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded cursor-pointer inline-block">
                        {upload.busy ? "Uploading..." : "Upload a file"}
                      </span>
                    </label>
                  </div>
                  {upload.visibility === "custom" && (
                    <PeoplePicker people={people.filter((p) => p.id !== me)} value={upload.shared} onChange={(shared) => setUpload({ ...upload, shared })} />
                  )}
                  <p className="text-xs text-slate-500">Any file type, up to 25 MB.</p>
                </div>
              )}
              {attachments.length === 0 && <p className="text-sm text-slate-500">No files you can see.</p>}
              <div className="space-y-2">
                {attachments.map((a) => (
                  <div key={a.id} className="bg-slate-900 rounded p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <a href={a.download_url} target="_blank" rel="noreferrer" className="flex-1 min-w-0 text-blue-400 hover:underline truncate">
                        {a.visibility !== "all" && "🔒 "}{a.file_name}
                      </a>
                      <a href={`${a.download_url}?download=1`} className="text-xs text-slate-400 hover:text-white">Download</a>
                      {a.can_manage && (
                        <>
                          <select value={a.visibility} onChange={(e) => setFileAccess(a, e.target.value)} className={`${input} text-xs py-1`} aria-label="File access">
                            <option value="all">Everyone</option>
                            <option value="restricted">Restricted</option>
                            <option value="custom">Custom</option>
                          </select>
                          {a.visibility === "custom" && (
                            <button onClick={() => setShareEdit(shareEdit === a.id ? null : a.id)} className="text-xs text-blue-400">
                              Shared with {a.shared_with?.length || 0}
                            </button>
                          )}
                          <button onClick={() => deleteFile(a)} className="text-xs text-slate-500 hover:text-red-400" aria-label="Delete file">✕</button>
                        </>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 mt-1">
                      {a.uploader_name} · {new Date(a.created_at).toLocaleString()} {a.file_size ? `· ${fmtSize(a.file_size)}` : ""}
                    </p>
                    {shareEdit === a.id && (
                      <div className="mt-2">
                        <PeoplePicker people={people.filter((p) => p.id !== a.uploaded_by)} value={a.shared_with || []}
                          onChange={(ids) => setFileAccess(a, "custom", ids)} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Comments (checklist #29 / #30) */}
          {access && tab === "comments" && (
            <>
              <div className="mb-4">
                <MentionTextarea
                  value={newComment}
                  onChange={setNewComment}
                  lookups={lookups}
                  rows={3}
                  placeholder={privateTo ? "Private comment - only the people you pick will see it..." : "Add a comment... type @ to tag people, teams, departments or groups"}
                  className={`${input} w-full resize-y ${privateTo ? "border-amber-600" : ""}`}
                />
                <div className="flex flex-wrap items-center gap-3 mt-2">
                  <button onClick={postComment} disabled={!newComment.trim() || (!!privateTo && privateTo.length === 0)} className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 px-4 py-2 rounded text-sm">
                    {privateTo ? "Send privately" : "Post"}
                  </button>
                  <label className="flex items-center gap-2 text-sm text-slate-300">
                    <input type="checkbox" checked={!!privateTo} onChange={(e) => setPrivateTo(e.target.checked ? [] : null)} />
                    🔒 Private - only people I pick can see it
                  </label>
                </div>
                {privateTo && (
                  <div className="mt-2 bg-slate-900 rounded p-2">
                    <p className="text-xs text-slate-400 mb-2">Send to:</p>
                    <PeoplePicker people={people.filter((p) => p.id !== me)} value={privateTo} onChange={setPrivateTo} />
                  </div>
                )}
              </div>
              <div className="space-y-2">
                {comments.length === 0 && <p className="text-sm text-slate-500">No comments yet.</p>}
                {comments.map((c) => (
                  <div key={c.id} className={`px-3 py-2 rounded text-sm ${c.is_private ? "bg-amber-950/40 border border-amber-800/60" : "bg-slate-900"}`}>
                    {c.is_private && (
                      <p className="text-xs text-amber-300 mb-1">
                        {(() => {
                          const others = (c.recipient_names || []).filter((_, i) => (c.recipients || [])[i] !== me);
                          return c.author_id === me
                            ? `🔒 Private · sent to ${others.join(", ") || "nobody"}`
                            : `🔒 Private · to you${others.length ? ` and ${others.join(", ")}` : ""}`;
                        })()}
                      </p>
                    )}
                    <div className="flex justify-between gap-2 items-baseline">
                      <span className="font-semibold text-slate-200">{c.author_name || nameOf(people, c.author_id, "Someone")}</span>
                      <span className="text-xs text-slate-500">
                        {new Date(c.created_at).toLocaleString()}{c.edited && " · edited"}
                      </span>
                    </div>
                    {editing?.id === c.id ? (
                      <div className="mt-2">
                        <textarea value={editing.text} onChange={(e) => setEditing({ id: c.id, text: e.target.value })} rows={3} className={`${input} w-full`} />
                        <div className="flex gap-2 mt-1">
                          <button onClick={saveEdit} className="px-3 py-1 bg-blue-600 rounded text-xs">Save</button>
                          <button onClick={() => setEditing(null)} className="px-3 py-1 bg-slate-700 rounded text-xs">Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <p className="text-slate-300 mt-1 whitespace-pre-wrap break-words">{c.content}</p>
                    )}
                    {(c.author_id === me || (access.isSuper && !c.is_private)) && editing?.id !== c.id && (
                      <div className="flex gap-3 mt-1">
                        {c.author_id === me && (
                          <button onClick={() => setEditing({ id: c.id, text: c.content })} className="text-xs text-slate-400 hover:text-white">Edit</button>
                        )}
                        <button onClick={() => deleteComment(c)} className="text-xs text-slate-400 hover:text-red-400">Delete</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          {/* History (checklist #41) */}
          {access && tab === "history" && (
            <ol className="space-y-2">
              {activity.length === 0 && <p className="text-sm text-slate-500">No history yet.</p>}
              {activity.map((a) => (
                <li key={a.id} className="bg-slate-900 rounded px-3 py-2 text-sm">
                  <p>
                    <span className="font-semibold text-slate-200">{a.user_name || "Someone"}</span>{" "}
                    <span className="text-slate-300">{a.action}</span>
                  </p>
                  {a.changes && typeof a.changes === "object" && Object.values(a.changes).some((v: any) => v && typeof v === "object" && "from" in v) && (
                    <ul className="text-xs text-slate-400 mt-1 space-y-0.5">
                      {Object.entries(a.changes).map(([k, v]: [string, any]) =>
                        v && typeof v === "object" && "from" in v ? (
                          <li key={k}>
                            {fieldLabel(k)}: {describeChange(a.names?.[v.from] ?? v.from)} → {describeChange(a.names?.[v.to] ?? v.to)}
                          </li>
                        ) : null
                      )}
                    </ul>
                  )}
                  <p className="text-xs text-slate-500 mt-1">{new Date(a.created_at).toLocaleString()}</p>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}

export function PeoplePicker({
  people,
  value,
  onChange,
}: {
  people: { id: string; name: string }[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {people.map((p) => {
        const on = value.includes(p.id);
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onChange(on ? value.filter((x) => x !== p.id) : [...value, p.id])}
            className={`px-2 py-1 rounded text-xs border ${on ? "bg-blue-600 border-blue-500 text-white" : "bg-slate-800 border-slate-600 text-slate-300"}`}
            aria-pressed={on}
          >
            {p.name}
          </button>
        );
      })}
    </div>
  );
}
