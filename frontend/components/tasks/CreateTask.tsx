'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase';

interface ProjectMember {
  id: string;
  user_id: string;
  name: string;
  email: string;
}

export default function CreateTask() {
  const [title, setTitle] = useState('');
  const [selectedProject, setSelectedProject] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const [projects, setProjects] = useState<any[]>([]);
  const [projectMembers, setProjectMembers] = useState<ProjectMember[]>([]);
  const [loading, setLoading] = useState(false);
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
    const { data } = await supabase
      .from('projects')
      .select('id, name')
      .order('created_at', { ascending: false });
    setProjects(data || []);
  }

  async function loadProjectMembers(projectId: string) {
    const { data: memberData } = await supabase
      .from('project_members')
      .select('id, user_id')
      .eq('project_id', projectId);

    if (!memberData) {
      setProjectMembers([]);
      return;
    }

    // Fetch user details
    const userIds = memberData.map(m => m.user_id);
    const { data: userData } = await supabase
      .from('users')
      .select('id, email, full_name')
      .in('id', userIds);

    const userMap = new Map(userData?.map(u => [u.id, u]) || []);

    setProjectMembers(
      memberData.map(m => {
        const user = userMap.get(m.user_id) || { email: '', full_name: 'Unknown' };
        return {
          id: m.id,
          user_id: m.user_id,
          email: user.email || '',
          name: user.full_name || 'Unknown'
        };
      })
    );
  }

  async function handleCreate() {
    if (!title || !selectedProject) {
      alert('Please fill in all required fields');
      return;
    }

    setLoading(true);
    try {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          project_id: selectedProject,
          assigned_to: assignedTo || null
        })
      });

      if (!response.ok) {
        const error = await response.json();
        alert(error.message || 'Failed to create task');
        return;
      }

      setTitle('');
      setSelectedProject('');
      setAssignedTo('');
      alert('Task created successfully');
    } catch (error) {
      alert('Error creating task');
      console.error(error);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bg-gray-900 p-6 rounded-lg space-y-4">
      <input
        type="text"
        placeholder="Task title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="w-full bg-gray-800 text-white px-4 py-2 rounded border border-gray-700 focus:border-blue-500 outline-none"
      />

      <select
        value={selectedProject}
        onChange={(e) => setSelectedProject(e.target.value)}
        className="w-full bg-gray-800 text-white px-4 py-2 rounded border border-gray-700 focus:border-blue-500"
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
          className="w-full bg-gray-800 text-white px-4 py-2 rounded border border-gray-700 focus:border-blue-500"
        >
          <option value="">Unassigned</option>
          {projectMembers.map(member => (
            <option key={member.id} value={member.user_id}>
              {member.name}
            </option>
          ))}
        </select>
      )}

      <button
        onClick={handleCreate}
        disabled={loading}
        className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white py-2 rounded font-medium"
      >
        {loading ? 'Creating...' : 'Create Task'}
      </button>
    </div>
  );
}
