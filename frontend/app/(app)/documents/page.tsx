"use client";

// Checklist #46: a standalone document library, separate from per-task
// attachments (#32). Files sit in folders and carry their own visibility
// (#47: desk-wide, one team, one department, or private to the uploader).

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { sendJSON } from "@/lib/api";
import { createClient } from "@/lib/supabase";

type Folder = { id: string; name: string; parent_id: string | null; created_by: string; created_at: string };
type Doc = {
  id: string;
  name: string;
  folder_id: string | null;
  file_size: number | null;
  file_type: string | null;
  visibility: "desk" | "team" | "department" | "private";
  team_id: string | null;
  department_id: string | null;
  uploaded_by: string;
  uploaded_by_name?: string;
  created_at: string;
  can_manage?: boolean;
};
type Crumb = { id: string; name: string };

const VIS_LABEL: Record<string, string> = {
  desk: "Everyone",
  team: "One team",
  department: "One department",
  private: "Just me",
};

function fmtSize(n: number | null) {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function iconFor(type: string | null) {
  const t = type || "";
  if (t.includes("pdf")) return "📕";
  if (t.includes("image")) return "🖼️";
  if (t.includes("sheet") || t.includes("excel") || t.includes("csv")) return "📊";
  if (t.includes("word") || t.includes("document")) return "📄";
  if (t.includes("zip") || t.includes("compressed")) return "🗜️";
  if (t.includes("video")) return "🎬";
  if (t.includes("audio")) return "🎵";
  return "📎";
}

export default function DocumentsPage() {
  const router = useRouter();
  const params = useSearchParams();
  const folderId = params.get("folder") || null;

  const [folders, setFolders] = useState<Folder[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  const [teams, setTeams] = useState<{ id: string; name: string }[]>([]);
  const [departments, setDepartments] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [newFolder, setNewFolder] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadVis, setUploadVis] = useState<{ visibility: string; team_id: string; department_id: string }>({
    visibility: "desk",
    team_id: "",
    department_id: "",
  });
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = useRef(false);

  const load = async () => {
    try {
      const url = folderId ? `/api/documents?folder_id=${folderId}` : "/api/documents";
      const r = await fetch(url, { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Could not load documents");
      setFolders(d.folders || []);
      setDocs(d.documents || []);
      setCrumbs(d.breadcrumb || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId]);

  useEffect(() => {
    (async () => {
      const r = await fetch("/api/teams", { cache: "no-store" });
      if (r.ok) {
        const d = await r.json();
        setTeams(d.teams || []);
        setDepartments(d.departments || []);
      }
    })();
  }, []);

  const openFolder = (id: string | null) => router.push(id ? `/documents?folder=${id}` : "/documents");

  const createFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFolder.trim() || busy.current) return;
    busy.current = true;
    try {
      await sendJSON("/api/document-folders", "POST", { name: newFolder.trim(), parent_id: folderId });
      setNewFolder("");
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      busy.current = false;
    }
  };

  const removeFolder = async (id: string) => {
    if (!confirm("Delete this folder? It must be empty.")) return;
    try {
      await sendJSON("/api/document-folders", "DELETE", { id });
      load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const uploadFile = async (file: File) => {
    if (file.size > 25 * 1024 * 1024) return setError("That file is larger than 25 MB.");
    setUploading(true);
    try {
      const { path, token } = await sendJSON("/api/documents/upload", "POST", {
        file_name: file.name,
        file_size: file.size,
      });
      const { error: upErr } = await createClient()
        .storage.from("documents")
        .uploadToSignedUrl(path, token, file, { contentType: file.type || "application/octet-stream" });
      if (upErr) throw new Error(upErr.message || "Upload failed");
      const doc = await sendJSON("/api/documents", "POST", {
        storage_path: path,
        name: file.name,
        file_size: file.size,
        file_type: file.type || null,
        folder_id: folderId,
        visibility: uploadVis.visibility,
        team_id: uploadVis.team_id || null,
        department_id: uploadVis.department_id || null,
      });
      setDocs((prev) => [doc, ...prev]);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const setVisibility = async (doc: Doc, visibility: string, team_id?: string, department_id?: string) => {
    try {
      const data = await sendJSON("/api/documents", "PUT", { id: doc.id, visibility, team_id, department_id });
      setDocs((prev) => prev.map((d) => (d.id === doc.id ? { ...d, ...data } : d)));
    } catch (e: any) {
      setError(e.message);
    }
  };

  const removeDoc = async (doc: Doc) => {
    if (!confirm(`Delete ${doc.name}?`)) return;
    try {
      await sendJSON("/api/documents", "DELETE", { id: doc.id });
      setDocs((prev) => prev.filter((d) => d.id !== doc.id));
    } catch (e: any) {
      setError(e.message);
    }
  };

  const inputCls = "px-3 py-2 bg-slate-900 border border-slate-600 rounded text-sm";

  if (loading) return <p className="text-slate-400 p-6">Loading documents...</p>;

  return (
    <div className="max-w-5xl mx-auto p-3 sm:p-6">
      <h1 className="text-2xl sm:text-3xl font-bold mb-4">📁 Documents</h1>
      {error && (
        <div className="bg-red-950 border border-red-800 text-red-300 px-4 py-3 rounded mb-4 text-sm flex justify-between">
          <span>{error}</span>
          <button onClick={() => setError("")}>dismiss</button>
        </div>
      )}

      {/* Breadcrumb */}
      <div className="flex flex-wrap items-center gap-1 text-sm mb-4 text-slate-400">
        <button onClick={() => openFolder(null)} className="hover:text-white">📁 All documents</button>
        {crumbs.map((c) => (
          <span key={c.id} className="flex items-center gap-1">
            <span>/</span>
            <button onClick={() => openFolder(c.id)} className="hover:text-white">{c.name}</button>
          </span>
        ))}
      </div>

      {/* New folder + upload */}
      <div className="bg-slate-800 border border-slate-700 rounded p-3 sm:p-4 mb-4 space-y-3">
        <form onSubmit={createFolder} className="flex flex-wrap gap-2">
          <input value={newFolder} onChange={(e) => setNewFolder(e.target.value)} placeholder="New folder name..." className={`${inputCls} flex-1 min-w-40`} />
          <button type="submit" disabled={!newFolder.trim()} className="px-3 py-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded text-sm">New folder</button>
        </form>
        <div className="flex flex-wrap gap-2 items-end pt-3 border-t border-slate-700">
          <label className="flex flex-col text-xs text-slate-400 gap-1">
            Who can see it
            <select value={uploadVis.visibility} onChange={(e) => setUploadVis({ ...uploadVis, visibility: e.target.value })} className={inputCls}>
              <option value="desk">Everyone (desk-wide)</option>
              <option value="team">One team</option>
              <option value="department">One department</option>
              <option value="private">Just me</option>
            </select>
          </label>
          {uploadVis.visibility === "team" && (
            <label className="flex flex-col text-xs text-slate-400 gap-1">
              Team
              <select value={uploadVis.team_id} onChange={(e) => setUploadVis({ ...uploadVis, team_id: e.target.value })} className={inputCls}>
                <option value="">Choose a team...</option>
                {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
          )}
          {uploadVis.visibility === "department" && (
            <label className="flex flex-col text-xs text-slate-400 gap-1">
              Department
              <select value={uploadVis.department_id} onChange={(e) => setUploadVis({ ...uploadVis, department_id: e.target.value })} className={inputCls}>
                <option value="">Choose a department...</option>
                {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
          )}
          <label className="flex flex-col text-xs text-slate-400 gap-1">
            File (up to 25 MB)
            <input
              ref={fileInput}
              type="file"
              disabled={uploading}
              onChange={(e) => e.target.files?.[0] && uploadFile(e.target.files[0])}
              className="text-sm"
            />
          </label>
          {uploading && <span className="text-xs text-slate-400">Uploading...</span>}
        </div>
      </div>

      {/* Folders */}
      {folders.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-4">
          {folders.map((f) => (
            <div key={f.id} className="bg-slate-800 border border-slate-700 rounded p-3 flex items-center justify-between gap-2 group">
              <button onClick={() => openFolder(f.id)} className="flex items-center gap-2 text-sm hover:text-blue-400 flex-1 text-left truncate">
                📁 {f.name}
              </button>
              <button onClick={() => removeFolder(f.id)} className="text-xs text-slate-500 hover:text-red-400 opacity-0 group-hover:opacity-100" aria-label={`Delete folder ${f.name}`}>✕</button>
            </div>
          ))}
        </div>
      )}

      {/* Documents */}
      {docs.length === 0 ? (
        <p className="text-slate-400">No documents in this folder yet.</p>
      ) : (
        <div className="grid gap-2">
          {docs.map((d) => (
            <div key={d.id} className="bg-slate-800 border border-slate-700 rounded p-3 flex flex-wrap items-center gap-3">
              <span className="text-2xl">{iconFor(d.file_type)}</span>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm truncate">{d.name}</p>
                <p className="text-xs text-slate-500">
                  {fmtSize(d.file_size)} · {d.uploaded_by_name || "Someone"} · {new Date(d.created_at).toLocaleDateString()}
                </p>
              </div>
              {d.can_manage ? (
                <select
                  value={d.visibility}
                  onChange={(e) => {
                    if (e.target.value === "team") {
                      const team_id = teams[0]?.id;
                      setVisibility(d, "team", team_id, undefined);
                    } else if (e.target.value === "department") {
                      const department_id = departments[0]?.id;
                      setVisibility(d, "department", undefined, department_id);
                    } else {
                      setVisibility(d, e.target.value);
                    }
                  }}
                  className={`${inputCls} text-xs`}
                  aria-label={`Visibility for ${d.name}`}
                >
                  <option value="desk">Everyone</option>
                  <option value="team">One team</option>
                  <option value="department">One department</option>
                  <option value="private">Just me</option>
                </select>
              ) : (
                <span className="text-xs text-slate-500 px-2 py-1 bg-slate-900 rounded">{VIS_LABEL[d.visibility]}</span>
              )}
              <a href={`/api/documents/${d.id}/download?download=1`} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-xs">Download</a>
              {d.can_manage && (
                <button onClick={() => removeDoc(d)} className="px-2 py-1.5 text-red-300 hover:text-red-400 text-xs">Delete</button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
