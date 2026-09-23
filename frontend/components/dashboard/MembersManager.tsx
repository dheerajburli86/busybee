'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase';

interface TeamMember {
  id: string;
  userId: string;
  email: string;
  name: string;
  role: 'admin' | 'supervisor' | 'manager' | 'member';
}

const ROLE_HIERARCHY = {
  admin: { label: 'Admin (Founder)', level: 4, description: 'Full access' },
  supervisor: { label: 'Supervisor (Senior)', level: 3, description: 'Manage tasks & members' },
  manager: { label: 'Manager', level: 2, description: 'Manage assigned tasks' },
  member: { label: 'Team Member', level: 1, description: 'Work on assigned tasks' },
} as const;

type Role = keyof typeof ROLE_HIERARCHY;

export default function MembersManager({ projectId }: { projectId: string }) {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState<Role>('member');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supabase = createClient();

  const loadMembers = useCallback(async () => {
    if (!projectId) return;

    const { data: rows, error: rowsError } = await supabase
      .from('project_members')
      .select('id, role, user_id')
      .eq('project_id', projectId);

    if (rowsError) {
      setError(rowsError.message);
      return;
    }

    const ids = Array.from(new Set((rows || []).map((r: any) => r.user_id).filter(Boolean)));
    let byId = new Map<string, { email: string; full_name: string | null }>();

    if (ids.length) {
      const { data: people } = await supabase
        .from('users')
        .select('id, email, full_name')
        .in('id', ids);
      byId = new Map((people || []).map((p: any) => [p.id, { email: p.email, full_name: p.full_name }]));
    }

    setError(null);
    setMembers(
      (rows || []).map((m: any) => {
        const person = byId.get(m.user_id);
        return {
          id: m.id,
          userId: m.user_id,
          email: person?.email || '',
          name: person?.full_name || person?.email || 'Unknown',
          role: m.role,
        };
      })
    );
  }, [projectId, supabase]);

  useEffect(() => {
    loadMembers();
  }, [loadMembers]);

  async function addMember() {
    const email = newEmail.trim().toLowerCase();
    if (!email) return;

    setLoading(true);
    setError(null);
    try {
      const { data: person } = await supabase
        .from('users')
        .select('id')
        .ilike('email', email)
        .maybeSingle();

      if (!person) {
        setError('No account found with that email address.');
        return;
      }

      const { error: insertError } = await supabase
        .from('project_members')
        .insert({ project_id: projectId, user_id: person.id, role: newRole });

      if (insertError) {
        setError(insertError.message);
        return;
      }

      setNewEmail('');
      setNewRole('member');
      await loadMembers();
    } finally {
      setLoading(false);
    }
  }

  async function removeMember(memberId: string) {
    const { error: deleteError } = await supabase
      .from('project_members')
      .delete()
      .eq('id', memberId);

    if (deleteError) {
      setError(deleteError.message);
      return;
    }
    await loadMembers();
  }

  async function updateRole(memberId: string, role: string) {
    const { error: updateError } = await supabase
      .from('project_members')
      .update({ role })
      .eq('id', memberId);

    if (updateError) {
      setError(updateError.message);
      return;
    }
    await loadMembers();
  }

  return (
    <div className="bg-gray-900 rounded-lg p-6 space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white mb-4">Team Members</h2>

        {error && (
          <div className="bg-red-900/40 border border-red-700 text-red-200 text-sm px-4 py-2 rounded mb-4">
            {error}
          </div>
        )}

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
              onChange={(e) => setNewRole(e.target.value as Role)}
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
          {members.length === 0 && (
            <p className="text-gray-500 text-sm">No members on this project yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
