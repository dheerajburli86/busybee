'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/utils/supabase/client';

export default function CreateTask() {
  const [title, setTitle] = useState('');
  const [selectedProject, setSelectedProject] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const [projects, setProjects] = useState<any[]>([]);
  const [projectMembers, setProjectMembers] = useState<any[]>([]);
  const supabase = createClient();

  useEffect(() => {
    loadProjects();
  }, []);

  useEffect(() => {
    if (selectedProject) {
      loadProjectMembers(selectedProject);
    }
  }, [selectedProject]);

  async function loadProjects() {
    const { data } = await supabase.from('projects').select('id, name');
    setProjects(data || []);
  }

  async function loadProjectMembers(projectId: string) {
    const { data } = await supabase
      .from('project_members')
      .select('id, auth.users(id, email, user_metadata)')
      .eq('project_id', projectId);

    setProjectMembers(data || []);
  }

  async function handleCreate() {
    if (!title || !selectedProject) {
      alert('Fill all fields');
      return;
    }

    const { error } = await supabase.from('tasks').insert({
      title,
      project_id: selectedProject,
      assigned_to: assignedTo || null
    });

    if (error) {
      alert(error.message);
      return;
    }

    setTitle('');
    setSelectedProject('');
    setAssignedTo('');
  }

  return (
    <div className="bg-gray-900 p-6 rounded-lg space-y-4">
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
        {projects.map(p => (
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
          {projectMembers.map(member => (
            <option key={member.id} value={member.id}>
              {member.auth.users.user_metadata?.name || member.auth.users.email}
            </option>
          ))}
        </select>
      )}

      <button
        onClick={handleCreate}
        className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2 rounded font-medium"
      >
        Create Task
      </button>
    </div>
  );
}
