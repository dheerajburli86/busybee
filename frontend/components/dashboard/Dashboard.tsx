'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/utils/supabase/client';
import MembersManager from './MembersManager';

export default function Dashboard() {
  const [projects, setProjects] = useState<any[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>('');
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
    const { data } = await supabase
      .from('project_members')
      .select(`
        id,
        role,
        auth.users (
          id,
          email,
          user_metadata
        )
      `)
      .eq('project_id', projectId);

    setProjectMembers(data || []);
  }

  return (
    <div className="space-y-6">
      {/* Project Selection - ONLY Dropdown */}
      <div className="bg-gray-900 rounded-lg p-4 border border-gray-700">
        <label className="block text-white text-sm font-medium mb-2">Project</label>
        <select
          value={selectedProject}
          onChange={(e) => setSelectedProject(e.target.value)}
          className="w-full bg-gray-800 text-white px-4 py-2 rounded border border-gray-700 focus:border-blue-500"
        >
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
                <span className="text-gray-300">{member.auth.users.user_metadata?.name || member.auth.users.email}</span>
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
