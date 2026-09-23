'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/utils/supabase/client';

interface TeamMember {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'supervisor' | 'manager' | 'member';
}

const ROLE_HIERARCHY = {
  admin: { label: 'Admin (Founder)', level: 4, description: 'Full access' },
  supervisor: { label: 'Supervisor (Senior)', level: 3, description: 'Manage tasks & members' },
  manager: { label: 'Manager', level: 2, description: 'Manage assigned tasks' },
  member: { label: 'Team Member', level: 1, description: 'Work on assigned tasks' }
};

export default function MembersManager({ projectId }: { projectId: string }) {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState<'member' | 'manager' | 'supervisor' | 'admin'>('member');
  const [loading, setLoading] = useState(false);
  const supabase = createClient();

  useEffect(() => {
    loadMembers();
  }, [projectId]);

  async function loadMembers() {
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

    if (data) {
      setMembers(
        data.map((m: any) => ({
          id: m.id,
          email: m.auth.users.email,
          name: m.auth.users.user_metadata?.name || m.auth.users.email,
          role: m.role
        }))
      );
    }
  }

  async function addMember() {
    if (!newEmail) return;

    setLoading(true);
    try {
      const { data: userData } = await supabase.auth.admin.getUserByEmail(newEmail);

      if (!userData?.user) {
        alert('User not found');
        return;
      }

      const { error } = await supabase
        .from('project_members')
        .insert({
          project_id: projectId,
          user_id: userData.user.id,
          role: newRole
        });

      if (error) {
        alert(error.message);
        return;
      }

      setNewEmail('');
      setNewRole('member');
      loadMembers();
    } finally {
      setLoading(false);
    }
  }

  async function removeMember(memberId: string) {
    const { error } = await supabase
      .from('project_members')
      .delete()
      .eq('id', memberId);

    if (error) {
      alert(error.message);
      return;
    }
    loadMembers();
  }

  async function updateRole(memberId: string, newRole: string) {
    const { error } = await supabase
      .from('project_members')
      .update({ role: newRole })
      .eq('id', memberId);

    if (error) {
      alert(error.message);
      return;
    }
    loadMembers();
  }

  return (
    <div className="bg-gray-900 rounded-lg p-6 space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white mb-4">Team Members</h2>

        <div className="bg-gray-800 p-4 rounded-lg mb-6 space-y-4">
          <div className="flex gap-4 flex-col sm:flex-row">
            <input
              type="email"
              placeholder="Email address"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              className="flex-1 bg-gray-700 text-white px-4 py-2 rounded border border-gray-600 focus:border-blue-500 outline-none"
            />
            <select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as any)}
              className="bg-gray-700 text-white px-4 py-2 rounded border border-gray-600 focus:border-blue-500"
            >
              {Object.entries(ROLE_HIERARCHY).map(([key, val]) => (
                <option key={key} value={key}>{val.label}</option>
              ))}
            </select>
            <button
              onClick={addMember}
              disabled={loading}
              className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-6 py-2 rounded font-medium"
            >
              {loading ? 'Adding...' : 'Add'}
            </button>
          </div>
        </div>

        <div className="space-y-2">
          {members.map((member) => (
            <div key={member.id} className="bg-gray-800 p-4 rounded-lg flex items-center justify-between">
              <div>
                <p className="text-white font-medium">{member.name}</p>
                <p className="text-gray-400 text-sm">{member.email}</p>
              </div>
              <div className="flex gap-3">
                <select
                  value={member.role}
                  onChange={(e) => updateRole(member.id, e.target.value)}
                  className="bg-gray-700 text-white px-3 py-1 rounded text-sm border border-gray-600"
                >
                  {Object.entries(ROLE_HIERARCHY).map(([key, val]) => (
                    <option key={key} value={key}>{val.label}</option>
                  ))}
                </select>
                <button
                  onClick={() => removeMember(member.id)}
                  className="bg-red-600 hover:bg-red-700 text-white px-4 py-1 rounded text-sm"
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
