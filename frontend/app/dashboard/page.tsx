"use client";

import { useState } from "react";

type Task = {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  progress_percent: number;
  due_date: string | null;
  created_at: string;
};

type Comment = {
  id: string;
  content: string;
  author_id: string;
  created_at: string;
};

type Attachment = {
  id: string;
  file_name: string;
  file_url: string;
  file_type: string;
  created_at: string;
};

type Subtask = {
  id: string;
  title: string;
  done: boolean;
  progress_percent: number;
};

export function TaskDetail({ task }: { task: Task }) {
  const [expanded, setExpanded] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [subtasks, setSubtasks] = useState<Subtask[]>([]);
  const [activity, setActivity] = useState<any[]>([]);
  const [newComment, setNewComment] = useState("");
  const [loading, setLoading] = useState(false);

  const loadTaskDetails = async () => {
    setLoading(true);
    try {
      const [commentsRes, attachmentsRes, subtasksRes, activityRes] = await Promise.all([
        fetch(`/api/tasks/${task.id}/comments`),
        fetch(`/api/tasks/${task.id}/attachments`),
        fetch(`/api/tasks/${task.id}/subtasks`),
        fetch(`/api/tasks/${task.id}/activity`),
      ]);

      if (commentsRes.ok) setComments(await commentsRes.json());
      if (attachmentsRes.ok) setAttachments(await attachmentsRes.json());
      if (subtasksRes.ok) setSubtasks(await subtasksRes.json());
      if (activityRes.ok) setActivity(await activityRes.json());
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const handleAddComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newComment.trim()) return;

    try {
      const res = await fetch(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: newComment.trim() }),
      });

      if (res.ok) {
        const comment = await res.json();
        setComments([comment, ...comments]);
        setNewComment("");
      }
    } catch (e) {
      console.error(e);
    }
  };

  if (!expanded)
    return (
      <div
        onClick={() => {
          setExpanded(true);
          loadTaskDetails();
        }}
        className="bg-slate-800 p-4 rounded border border-slate-700 cursor-pointer hover:border-blue-500"
      >
        <div className="flex justify-between items-start mb-2">
          <h3 className="font-bold text-lg">{task.title}</h3>
          <span className={`text-xs px-2 py-1 rounded ${getStatusColor(task.status)}`}>
            {task.status}
          </span>
        </div>
        {task.description && <p className="text-slate-400 text-sm mb-2">{task.description}</p>}
        <div className="flex gap-4 text-xs text-slate-500 mb-2">
          <span>Priority: {task.priority}</span>
          <span>Progress: {task.progress_percent}%</span>
          {task.due_date && <span>Due: {new Date(task.due_date).toLocaleDateString()}</span>}
        </div>
        <div className="w-full bg-slate-900 rounded h-2">
          <div
            className="bg-blue-600 h-2 rounded"
            style={{ width: `${task.progress_percent}%` }}
          />
        </div>
      </div>
    );

  return (
    <div className="bg-slate-800 p-6 rounded border border-slate-700">
      <button
        onClick={() => setExpanded(false)}
        className="text-slate-400 hover:text-white mb-4"
      >
        ← Back
      </button>

      {/* Task Header */}
      <div className="mb-6">
        <h2 className="text-2xl font-bold mb-2">{task.title}</h2>
        <div className="flex gap-4 text-sm">
          <select
            defaultValue={task.status}
            onChange={(e) => {}}
            className="bg-slate-900 border border-slate-600 rounded px-2 py-1"
          >
            <option value="pending">Pending</option>
            <option value="in_progress">In Progress</option>
            <option value="done">Done</option>
            <option value="need_help">Need Help</option>
          </select>
          <select
            defaultValue={task.priority}
            onChange={(e) => {}}
            className="bg-slate-900 border border-slate-600 rounded px-2 py-1"
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="super_high">Super High</option>
          </select>
          {task.due_date && (
            <span className="text-slate-400">Due: {new Date(task.due_date).toLocaleDateString()}</span>
          )}
        </div>
      </div>

      {/* Description */}
      {task.description && (
        <div className="mb-6">
          <h3 className="font-bold mb-2">Description</h3>
          <p className="text-slate-300">{task.description}</p>
        </div>
      )}

      {/* Progress */}
      <div className="mb-6">
        <h3 className="font-bold mb-2">Progress: {task.progress_percent}%</h3>
        <div className="w-full bg-slate-900 rounded h-4">
          <div
            className="bg-blue-600 h-4 rounded"
            style={{ width: `${task.progress_percent}%` }}
          />
        </div>
        <input
          type="range"
          min="0"
          max="100"
          defaultValue={task.progress_percent}
          onChange={(e) => {}}
          className="w-full mt-2"
        />
      </div>

      {/* Subtasks */}
      {subtasks.length > 0 && (
        <div className="mb-6">
          <h3 className="font-bold mb-3">Subtasks ({subtasks.filter((s) => s.done).length}/{subtasks.length})</h3>
          <div className="space-y-2">
            {subtasks.map((subtask) => (
              <div key={subtask.id} className="flex items-center gap-3 bg-slate-900 p-3 rounded">
                <input type="checkbox" defaultChecked={subtask.done} className="w-4 h-4" />
                <span className={subtask.done ? "line-through text-slate-500" : ""}>{subtask.title}</span>
                <span className="text-xs text-slate-500 ml-auto">{subtask.progress_percent}%</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Attachments */}
      {attachments.length > 0 && (
        <div className="mb-6">
          <h3 className="font-bold mb-2">Attachments ({attachments.length})</h3>
          <div className="space-y-1">
            {attachments.map((att) => (
              <a
                key={att.id}
                href={att.file_url}
                target="_blank"
                className="block text-blue-400 hover:underline text-sm truncate"
              >
                📎 {att.file_name}
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Comments */}
      <div className="mb-6">
        <h3 className="font-bold mb-3">Comments ({comments.length})</h3>
        <form onSubmit={handleAddComment} className="mb-4">
          <textarea
            value={newComment}
            onChange={(e) => setNewComment(e.target.value)}
            placeholder="Add a comment..."
            className="w-full px-3 py-2 bg-slate-900 border border-slate-600 rounded mb-2 resize-none"
            rows={3}
          />
          <button
            type="submit"
            disabled={!newComment.trim()}
            className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 rounded text-sm"
          >
            Post Comment
          </button>
        </form>
        <div className="space-y-3">
          {comments.map((comment) => (
            <div key={comment.id} className="bg-slate-900 p-3 rounded text-sm">
              <p className="text-slate-300">{comment.content}</p>
              <p className="text-slate-500 text-xs mt-1">
                {new Date(comment.created_at).toLocaleString()}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Activity Log */}
      {activity.length > 0 && (
        <div>
          <h3 className="font-bold mb-3">Activity</h3>
          <div className="space-y-2 text-sm">
            {activity.map((log) => (
              <p key={log.id} className="text-slate-400">
                {log.action} · {new Date(log.created_at).toLocaleString()}
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function getStatusColor(status: string) {
  const colors: Record<string, string> = {
    pending: "bg-slate-700 text-slate-300",
    in_progress: "bg-blue-900 text-blue-300",
    done: "bg-green-900 text-green-300",
    need_help: "bg-red-900 text-red-300",
  };
  return colors[status] || "bg-slate-700 text-slate-300";
}
