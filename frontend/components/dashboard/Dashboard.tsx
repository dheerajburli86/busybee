'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase';
import MembersManager from './MembersManager';

interface ProjectMember {
  id: string;
  role: string;
  user_id: string;
  userName?: string;
}

export default function Dashboard() {
  const [projects, setProjects] = useState<any[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>('');
  const [projectMembers, setProjectMembers] = useState<ProjectMember[]>([]);
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
      .select('id, name, color')
      .order('created_at', { ascending: false });

    setProjects(data || []);
    if (data && data.length > 0) {
      setSelectedProject(data[0].id);
    }
  }

  async function loadProjectMembers(projectId: string) {
    const { data: memberData } = await supabase
      .from('project_members')
      .select('id, role, user_id')
      .eq('project_id', projectId);

    if (!memberData) {
      setProjectMembers([]);
      return;
    }

    // Fetch user details for each member
    const memberIds = memberData.map(m => m.user_id);
    const { data: userData } = await supabase
      .from('users')
      .select('id, full_name')
      .in('id', memberIds);

    const userMap = new Map(userData?.map(u => [u.id, u.full_name]) || []);

    setProjectMembers(
      memberData.map(m => ({
        ...m,
        userName: userMap.get(m.user_id) || 'Unknown'
      }))
    );
  }

  return (
    <div className="space-y-6">
      {/* Project Selection */}
      <div className="bg-gray-900 rounded-lg p-4 border border-gray-700">
        <label className="block text-white text-sm font-medium mb-2">Project</label>
        <select
          value={selectedProject}
          onChange={(e) => setSelectedProject(e.target.value)}
          className="w-full bg-gray-800 text-white px-4 py-2 rounded border border-gray-700 focus:border-blue-500"
        >
          <option value="">Select a project</option>
          {projects.map(proj => (
            <option key={proj.id} value={proj.id}>{proj.name}</option>
          ))}
        </select>
      </div>

      {/* Project Members Display */}
      {selectedProject && (
        <div className="bg-gray-900 rounded-lg p-4 border border-gray-700">
          <h3 className="text-white font-medium mb-3">Project Members</h3>
          <div className="space-y-2">
            {projectMembers.map(member => (
              <div key={member.id} className="flex items-center gap-2 text-sm">
                <span className="inline-block w-2 h-2 bg-blue-500 rounded-full"></span>
                <span className="text-gray-300">{member.userName}</span>
                <span className="text-xs bg-gray-700 px-2 py-1 rounded text-gray-400">
                  {member.role}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Members Manager */}
      {selectedProject && <MembersManager projectId={selectedProject} />}
    </div>
  );
}
