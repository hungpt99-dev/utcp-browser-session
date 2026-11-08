/**
 * Fixture data for the local test website.
 *
 * Kept deterministic so tests can assert exact before/after state.
 */
export interface Task {
  id: number;
  title: string;
  description: string;
  status: 'open' | 'in_progress' | 'done';
  priority: number;
  owner: string;
  createdAt: string;
}

export interface SiteUser {
  username: string;
  password: string;
  role: 'member' | 'admin';
  displayName: string;
}

export const USERS: SiteUser[] = [
  { username: 'alice', password: 'correct-horse', role: 'member', displayName: 'Alice Nguyen' },
  { username: 'root', password: 'admin-pass', role: 'admin', displayName: 'Root Operator' },
];

export const INITIAL_TASKS: Task[] = [
  {
    id: 1,
    title: 'Write the acceptance report',
    description: 'Every criterion needs a command and real output.',
    status: 'open',
    priority: 2,
    owner: 'alice',
    createdAt: '2026-11-01T09:00:00.000Z',
  },
  {
    id: 2,
    title: 'Verify cookie scoping',
    description: 'The extension must never read HttpOnly cookies.',
    status: 'in_progress',
    priority: 1,
    owner: 'alice',
    createdAt: '2026-11-01T10:30:00.000Z',
  },
  {
    id: 3,
    title: 'Old duplicate',
    description: 'Deletable fixture row.',
    status: 'done',
    priority: 3,
    owner: 'alice',
    createdAt: '2026-10-28T16:45:00.000Z',
  },
];

export const PROJECTS = [
  { id: 'proj-1', name: 'Apollo', taskIds: [1, 2] },
  { id: 'proj-2', name: 'Borealis', taskIds: [3] },
];

export function cloneTasks(): Task[] {
  return INITIAL_TASKS.map((task) => ({ ...task }));
}
