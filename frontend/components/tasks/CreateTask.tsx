'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase';

interface ProjectRow {
  id: string;
  name: string;
}

interface MemberOption {
  userId: string;
  name: string;
}

export default function CreateTask({ onCreated }: { onCreated?: () => void }) {
  const [title, setTitle] = useState('');
  const [selectedProject, setSelectedProject] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [projectMembers, setProjectMembers] = useState<MemberOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supabase = createClient();

  const loadProjects = useCallback(async () => {
    const { data } = await supabase.from('projects').select('id, name').order('name');
    setProjects((data || []) as ProjectRow[]);
  }, [supabase]);

  const loadProjectMembers = useCallback(
    async (projectId: string) => {
      const { data: rows } = await supabase
        .from('project_members')
        .select('user_id')
        .eq('project_id', projectId);

      const ids = Array.from(new Set((rows || []).map((r: any) => r.user_id).filter(Boolean)));
      if (!ids.length) {
        setProjectMembers([]);
        return;
      }

      const { data: people } = await supabase
        .from('users')
        .select('id, email, full_name')
        .in('id', ids);

      setProjectMembers(
        (people || []).map((p: any) => ({
          userId: p.id,
          name: p.full_name || p.email,
        }))
      );
    },
    [supabase]
  );

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    setAssignedTo('');
    if (selectedProject) {
      loadProjectMembers(selectedProject);
    } else {
      setProjectMembers([]);
    }
  }, [selectedProject, loadProjectMembers]);

  async function handleCreate() {
    if (!title.trim() || !selectedProject) {
      setError('Give the task a title and pick a project.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          project_id: selectedProject,
          assigned_to: assignedTo || null,
        }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setError(payload.error || 'Could not create the task.');
        return;
      }

      setTitle('');
      setSelectedProject('');
      setAssignedTo('');
      onCreated?.();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-gray-900 p-6 rounded-lg space-y-4">
      {error && (
        <div className="bg-red-900/40 border border-red-700 text-red-200 text-sm px-4 py-2 rounded">
          {error}
        </div>
      )}

      <input
        type="text"
        placeholder="Task title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="w-full bg-gray-800 text-white px-4 py-2 rounded border border-gray-700"
      />

      <select
        value={selectedProject}
        onChange={(e) => setSelectedProject(e.target.value)}
        className="w-full bg-gray-800 text-white px-4 py-2 rounded border border-gray-700"
      >
        <option value="">Select Project</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>

      {selectedProject && (
        <select
          value={assignedTo}
          onChange={(e) => setAssignedTo(e.target.value)}
          className="w-full bg-gray-800 text-white px-4 py-2 rounded border border-gray-700"
        >
          <option value="">Unassigned</option>
          {projectMembers.map((member) => (
            <option key={member.userId} value={member.userId}>
              {member.name}
            </option>
          ))}
        </select>
      )}

      <button
        onClick={handleCreate}
        disabled={saving}
        className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white py-2 rounded font-medium"
      >
        {saving ? 'Creating...' : 'Create Task'}
      </button>
    </div>
  );
}
