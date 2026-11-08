/**
 * Permission classification for a discovered endpoint.
 *
 * The HTTP method is *evidence*, not the decision. A `GET /tasks/3/delete` is
 * destructive, a `POST /api/search` is read-only, and a GraphQL POST is whatever
 * its operation name says it is. Path tokens, observed body, response shape and
 * GraphQL operation names all contribute; the method only breaks ties.
 *
 * Classification stays conservative: an operation is labelled READ only when the
 * evidence says read-only. Anything ambiguous keeps `confident: false`, which
 * forces human review before a tool can be approved.
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

const DESTRUCTIVE_VERB = /^(delete|destroy|remove|purge|drop|revoke|terminate|wipe|archive|deactivate|suspend|reset|unlink|detach)$/i;
const READ_VERB = /^(get|list|search|find|query|filter|count|preview|lookup|view|read|fetch|browse|show|status|health)$/i;
const WRITE_VERB = /^(create|update|edit|add|upload|invite|assign|comment|move|rename|import|send|submit|patch|set|save|publish|approve|accept|enable|start|run|execute|trigger|duplicate|clone|copy|restore|reorder|attach|link|join|leave|star|unstar|vote)$/i;

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface ClassificationInput {
  method: string;
  path: string;
  kind?: 'rest' | 'graphql' | 'upload' | 'download' | 'stream' | 'unknown';
  /** GraphQL operation name, when known. */
  operationName?: string | null;
  hasBody?: boolean;
  responseIsArray?: boolean;
}

export interface Classification {
  level: PermissionLevel;
  confident: boolean;
  reason: string;
  /** Machine-readable evidence, shown to the reviewer. */
  signals: string[];
}

function pathTokens(path: string): string[] {
  return String(path || '/')
    .split(/[/_.\-?&=]+/)
    .filter((token) => token.length > 1 && !/^\d+$/.test(token));
}

/** Split a camelCase / snake_case operation name into lowercase verbs. */
function operationTokens(name: string): string[] {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_\-]+/)
    .map((token) => token.toLowerCase())
    .filter(Boolean);
}

export function classifyPermission(input: ClassificationInput): Classification {
  const method = String(input.method || '').toUpperCase();
  const path = String(input.path || '/');
  const tokens = pathTokens(path);
  const signals: string[] = [`method:${method || 'unknown'}`];

  const destructiveToken = tokens.find((token) => DESTRUCTIVE_VERB.test(token));
  if (destructiveToken) {
    signals.push(`path-verb:${destructiveToken.toLowerCase()}`);
    return {
      level: Permission.DESTRUCTIVE,
      confident: true,
      reason: `Path segment "${destructiveToken}" removes or disables server state, regardless of the ${method || 'unknown'} method.`,
      signals,
    };
  }

  if (input.kind === 'graphql' && input.operationName) {
    const ops = operationTokens(input.operationName);
    const destructiveOp = ops.find((token) => DESTRUCTIVE_VERB.test(token));
    if (destructiveOp) {
      signals.push(`graphql:${input.operationName}`);
      return {
        level: Permission.DESTRUCTIVE,
        confident: true,
        reason: `GraphQL operation "${input.operationName}" is a destructive mutation.`,
        signals,
      };
    }
    const readOp = ops.find((token) => READ_VERB.test(token));
    const writeOp = ops.find((token) => WRITE_VERB.test(token));
    signals.push(`graphql:${input.operationName}`);
    if (readOp && !writeOp) {
      return {
        level: Permission.READ,
        confident: true,
        reason: `GraphQL operation "${input.operationName}" is a query ("${readOp}").`,
        signals,
      };
    }
    return {
      level: Permission.WRITE,
      confident: Boolean(writeOp),
      reason: writeOp
        ? `GraphQL operation "${input.operationName}" mutates state ("${writeOp}").`
        : `GraphQL operation "${input.operationName}" is not recognisably a query; review it.`,
      signals,
    };
  }

  if (method === 'DELETE') {
    signals.push('method-delete');
    return {
      level: Permission.DESTRUCTIVE,
      confident: true,
      reason: 'DELETE removes server state.',
      signals,
    };
  }

  const readToken = tokens.find((token) => READ_VERB.test(token));
  const writeToken = tokens.find((token) => WRITE_VERB.test(token));

  if (readToken && !writeToken) {
    signals.push(`path-verb:${readToken.toLowerCase()}`);
    if (READ_METHODS.has(method)) {
      return {
        level: Permission.READ,
        confident: true,
        reason: `Read verb "${readToken}" with ${method}.`,
        signals,
      };
    }
    if (BODY_METHODS.has(method) && input.hasBody) {
      return {
        level: Permission.READ,
        confident: true,
        reason: `Search/query endpoint: ${method} with a body but a read-only verb "${readToken}".`,
        signals,
      };
    }
  }

  if (writeToken) {
    signals.push(`path-verb:${writeToken.toLowerCase()}`);
    return {
      level: Permission.WRITE,
      confident: true,
      reason: `Path verb "${writeToken}" changes server state.`,
      signals,
    };
  }

  if (input.kind === 'upload') {
    signals.push('kind:upload');
    return {
      level: Permission.WRITE,
      confident: true,
      reason: 'Multipart upload writes stored content.',
      signals,
    };
  }

  if (READ_METHODS.has(method) && !input.hasBody) {
    if (input.kind === 'download') signals.push('kind:download');
    if (input.responseIsArray) signals.push('response:array');
    return {
      level: Permission.READ,
      confident: true,
      reason: `${method} without a body and without a mutating path verb.`,
      signals,
    };
  }

  if (BODY_METHODS.has(method)) {
    signals.push('mutating-method');
    return {
      level: Permission.WRITE,
      confident: true,
      reason: `${method} carries a body and no read-only verb, so it is treated as a write.`,
      signals,
    };
  }

  return {
    level: Permission.WRITE,
    confident: false,
    reason: `Method "${method || 'unknown'}" is not recognised; a human must review it.`,
    signals,
  };
}

/** True when executing this level needs the caller to pass an explicit confirmation. */
export function requiresConfirmation(level: PermissionLevel, domainConfirmsWrites = false): boolean {
  if (level === 'DESTRUCTIVE') return true;
  return domainConfirmsWrites && level === 'WRITE';
}

/** True when the level mutates state and therefore needs written approval. */
export function requiresApproval(level: PermissionLevel): boolean {
  return level === 'WRITE' || level === 'DESTRUCTIVE';
}

/** Clamp a tool's permission to what its domain allows. */
export function clampPermission(level: PermissionLevel, max: PermissionLevel): PermissionLevel {
  return PERMISSION_ORDER[level] > PERMISSION_ORDER[max] ? max : level;
}
