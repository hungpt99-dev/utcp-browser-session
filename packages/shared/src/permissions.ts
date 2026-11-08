/**
 * Permission classification for a discovered endpoint.
 *
 * Classification is deliberately conservative: an operation is only labelled
 * READ when it is confidently read-only, and anything we cannot classify keeps
 * `confident: false`, which forces human review before the tool can be approved.
 */
export const Permission = {
  READ: 'READ',
  WRITE: 'WRITE',
  DESTRUCTIVE: 'DESTRUCTIVE',
} as const;

export type PermissionLevel = (typeof Permission)[keyof typeof Permission];

export const PERMISSION_ORDER: Record<PermissionLevel, number> = {
  READ: 0,
  WRITE: 1,
  DESTRUCTIVE: 2,
};

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH']);
/** Path fragments that make an otherwise-write operation destructive. */
const DESTRUCTIVE_PATH = /(^|[/_.-])(delete|destroy|remove|purge|drop|revoke|terminate|wipe|reset|archive|deactivate|disable)([/_.-]|$)/i;

export interface Classification {
  level: PermissionLevel;
  confident: boolean;
  reason: string;
}

export function classifyPermission(method: string, path: string): Classification {
  const m = String(method || '').toUpperCase();
  const p = String(path || '/');

  if (READ_METHODS.has(m)) {
    return { level: Permission.READ, confident: true, reason: `${m} is treated as read-only.` };
  }

  if (m === 'DELETE') {
    return { level: Permission.DESTRUCTIVE, confident: true, reason: 'DELETE removes server state.' };
  }

  if (WRITE_METHODS.has(m)) {
    if (DESTRUCTIVE_PATH.test(p)) {
      return { level: Permission.DESTRUCTIVE, confident: true, reason: `Path "${p}" matches a destructive verb.` };
    }
    return { level: Permission.WRITE, confident: true, reason: `${m} mutates server state.` };
  }

  return {
    level: Permission.WRITE,
    confident: false,
    reason: `Method "${m || 'unknown'}" is not recognised; a human must review it.`,
  };
}

/** True when executing this level needs the caller to pass an explicit confirmation. */
export function requiresConfirmation(level: PermissionLevel): boolean {
  return level === Permission.DESTRUCTIVE;
}

/** True when the level mutates state and therefore needs written approval. */
export function requiresApproval(level: PermissionLevel): boolean {
  return level === Permission.WRITE || level === Permission.DESTRUCTIVE;
}
