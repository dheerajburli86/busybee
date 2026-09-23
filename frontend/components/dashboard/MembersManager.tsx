'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase';

interface TeamMember {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'supervisor' | 'manager' | 'member';
  user_id: string;
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
    const { data: memberData } = await supabase
      .from('project_members')
      .select('id, role, user_id')
      .eq('project_id', projectId);

    if (!memberData) {
      setMembers([]);
      return;
    }

    // Fetch user details
    const userIds = memberData.map(m => m.user_id);
    const { data: userData } = await supabase
      .from('users')
      .select('id, email, full_name')
      .in('id', userIds);

    const userMap = new Map(userData?.map(u => [u.id, u]) || []);

    setMembers(
      memberData.map((m: any) => {
        const user = userMap.get(m.user_id) || { email: '', full_name: 'Unknown' };
        return {
          id: m.id,
          email: user.email || '',
          name: user.full_name || 'Unknown',
          role: m.role,
          user_id: m.user_id
        };
      })
    );
  }

  async function addMember() {
    if (!newEmail) return;

    setLoading(true);
    try {
      // Use server API to add member (avoids admin SDK on browser)
      const response = await fetch('/api/team/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          email: newEmail,
          role: newRole
        })
      });

      if (!response.ok) {
        const error = await response.json();
        alert(error.message || 'Failed to add member');
        return;
      }

      setNewEmail('');
      setNewRole('member');
      loadMembers();
    } catch (error) {
      alert('Error adding member');
      console.error(error);
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
