import { Database } from '@/types/database.types';

export type UserRole = 'admin' | 'supervisor' | 'manager' | 'member';

interface TaskPermissions {
  canView: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canAssign: boolean;
  canArchive: boolean;
}

export async function getTaskPermissions(
  taskId: string,
  userId: string,
  supabase: any
): Promise<TaskPermissions> {
  const { data: task, error } = await supabase
    .from('tasks')
    .select('owner_id, project_id, assigned_to')
    .eq('id', taskId)
    .single();

  if (error || !task) {
    return {
      canView: false,
      canEdit: false,
      canDelete: false,
      canAssign: false,
      canArchive: false
    };
  }

  if (!task.project_id) {
    return {
      canView: task.owner_id === userId,
      canEdit: task.owner_id === userId,
      canDelete: task.owner_id === userId,
      canAssign: false,
      canArchive: task.owner_id === userId
    };
  }

  const { data: membership } = await supabase
    .from('project_members')
    .select('role')
    .eq('project_id', task.project_id)
    .eq('user_id', userId)
    .single();

  const userRole = membership?.role || 'member';
  const isAdmin = userRole === 'admin';
  const isSupervisor = userRole === 'supervisor';
  const isManager = userRole === 'manager';
  const isAssignee = task.assigned_to === userId;

  return {
    canView: true,
    canEdit: isAdmin || isSupervisor || isManager || isAssignee,
    canDelete: isAdmin || isSupervisor,
    canAssign: isAdmin || isSupervisor || isManager,
    canArchive: isAdmin || isSupervisor || isManager
  };
}

export async function getProjectPermissions(
  projectId: string,
  userId: string,
  supabase: any
) {
  const { data: membership } = await supabase
    .from('project_members')
    .select('role')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .single();

  const role = membership?.role || 'member';

  return {
    canManage: role === 'admin' || role === 'supervisor',
    role
  };
}
