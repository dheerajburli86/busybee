'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase';
import MembersManager from './MembersManager';

interface ProjectRow {
  id: string;
  name: string;
  color: string | null;
}

interface MemberRow {
  id: string;
  role: string;
  name: string;
}

export default function Dashboard() {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>('');
  const [projectMembers, setProjectMembers] = useState<MemberRow[]>([]);
  const supabase = createClient();

  const loadProjects = useCallback(async () => {
    const { data } = await supabase
      .from('projects')
      .select('id, name, color')
      .order('created_at', { ascending: false });

    const rows = (data || []) as ProjectRow[];
    setProjects(rows);
    if (rows.length > 0) {
      setSelectedProject((current) => current || rows[0].id);
    }
  }, [supabase]);

  const loadProjectMembers = useCallback(
    async (projectId: string) => {
      const { data: rows } = await supabase
        .from('project_members')
        .select('id, role, user_id')
        .eq('project_id', projectId);

      const ids = Array.from(new Set((rows || []).map((r: any) => r.user_id).filter(Boolean)));
      let byId = new Map<string, string>();

      if (ids.length) {
        const { data: people } = await supabase
          .from('users')
          .select('id, email, full_name')
          .in('id', ids);
        byId = new Map((people || []).map((p: any) => [p.id, p.full_name || p.email]));
      }

      setProjectMembers(
        (rows || []).map((m: any) => ({
          id: m.id,
          role: m.role,
          name: byId.get(m.user_id) || 'Unknown',
        }))
      );
    },
    [supabase]
  );

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    if (selectedProject) {
      loadProjectMembers(selectedProject);
    }
  }, [selectedProject, loadProjectMembers]);

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
          {projects.map((proj) => (
            <option key={proj.id} value={proj.id}>{proj.name}</option>
          ))}
        </select>
      </div>

      {/* Project Members Display */}
      {selectedProject && (
        <div className="bg-gray-900 rounded-lg p-4 border border-gray-700">
          <h3 className="text-white font-medium mb-3">Project Members</h3>
          <div className="space-y-2">
            {projectMembers.map((member) => (
              <div key={member.id} className="flex items-center gap-2 text-sm">
                <span className="inline-block w-2 h-2 bg-blue-500 rounded-full" />
                <span className="text-gray-300">{member.name}</span>
                <span className="text-xs bg-gray-700 px-2 py-1 rounded text-gray-400">
                  {member.role}
                </span>
              </div>
            ))}
            {projectMembers.length === 0 && (
              <p className="text-gray-500 text-sm">No members on this project yet.</p>
            )}
          </div>
        </div>
      )}

      {/* Members Manager */}
      {selectedProject && <MembersManager projectId={selectedProject} />}
    </div>
  );
}
