import type {
  AuditEvent,
  DiscoveredEndpointRecord,
  DomainRecord,
  ExecutionRecord,
  ToolRecord,
} from '@utcp-browser-session/shared';

export interface RuntimeStatus {
  ok: boolean;
  runtimeId: string;
  version: string;
  connection: {
    connected: boolean;
    client: { clientId: string; label: string; connectedAt: string } | null;
    capturing: string[];
    counters: { discoveryFrames: number; observationsIngested: number; observationsDropped: number; resultsReceived: number };
  };
  stats: {
    domains: number;
    enabledDomains: number;
    endpoints: number;
    tools: number;
    approved: number;
    drafts: number;
    revoked: number;
    executions: number;
    clients: number;
  };
  settings: { manualName: string; defaultTimeoutMs: number; maxResponseBytes: number; rateLimitPerMinute: number };
  tokenVariable: string;
}

export interface DomainSummary extends DomainRecord {
  endpoints: number;
  approvedTools: number;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class Api {
  private readonly base: string;
  private readonly token: string;

  constructor(base: string, token: string) {
    this.base = base.replace(/\/$/, '');
    this.token = token;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!response.ok) {
      const record = (body ?? {}) as { error?: string; message?: string };
      throw new ApiError(response.status, record.error ?? 'http_error', record.message ?? `HTTP ${response.status}`);
    }
    return body as T;
  }

  status(): Promise<RuntimeStatus> {
    return this.request<RuntimeStatus>('/api/v1/status');
  }

  domains(): Promise<{ domains: DomainSummary[] }> {
    return this.request('/api/v1/domains');
  }

  addDomain(input: {
    domain: string;
    deepCapture: boolean;
    csrf?: { bootstrapPath: string; tokenField: string; header: string };
  }): Promise<{ domain: DomainRecord }> {
    return this.request('/api/v1/domains', { method: 'POST', body: JSON.stringify(input) });
  }

  removeDomain(domain: string): Promise<{ ok: boolean }> {
    return this.request(`/api/v1/domains/${encodeURIComponent(domain)}`, { method: 'DELETE' });
  }

  startDiscovery(domain: string): Promise<{ ok: boolean }> {
    return this.request(`/api/v1/domains/${encodeURIComponent(domain)}/discovery`, { method: 'POST' });
  }

  stopDiscovery(domain: string): Promise<{ ok: boolean }> {
    return this.request(`/api/v1/domains/${encodeURIComponent(domain)}/discovery`, { method: 'DELETE' });
  }

  endpoints(domain?: string): Promise<{ endpoints: DiscoveredEndpointRecord[] }> {
    return this.request(`/api/v1/endpoints${domain ? `?domain=${encodeURIComponent(domain)}` : ''}`);
  }

  tools(status?: string): Promise<{ tools: ToolRecord[] }> {
    return this.request(`/api/v1/tools${status ? `?status=${status}` : ''}`);
  }

  generate(domain: string, endpointKeys?: string[]): Promise<{ created: ToolRecord[]; skipped: string[] }> {
    return this.request('/api/v1/tools/generate', {
      method: 'POST',
      body: JSON.stringify({ domain, endpointKeys }),
    });
  }

  approve(id: string): Promise<{ tool: ToolRecord }> {
    return this.request(`/api/v1/tools/${id}/approve`, { method: 'POST' });
  }

  revoke(id: string): Promise<{ tool: ToolRecord }> {
    return this.request(`/api/v1/tools/${id}/revoke`, { method: 'POST' });
  }

  deleteTool(id: string): Promise<{ ok: boolean }> {
    return this.request(`/api/v1/tools/${id}`, { method: 'DELETE' });
  }

  renameTool(id: string, patch: { name?: string; description?: string }): Promise<{ tool: ToolRecord }> {
    return this.request(`/api/v1/tools/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
  }

  execute(input: {
    tool: string;
    args: Record<string, unknown>;
    confirm?: boolean;
  }): Promise<{
    ok: boolean;
    status: number;
    latencyMs: number;
    body: unknown;
    headers: Record<string, string>;
    truncated: boolean;
    executionId: string;
    error?: { code: string; message: string; hint?: string };
  }> {
    return this.request('/api/v1/execute', {
      method: 'POST',
      body: JSON.stringify({ ...input, actor: 'dashboard' }),
    });
  }

  executions(limit = 50): Promise<{ executions: ExecutionRecord[] }> {
    return this.request(`/api/v1/executions?limit=${limit}`);
  }

  audit(limit = 100): Promise<{ events: AuditEvent[] }> {
    return this.request(`/api/v1/audit?limit=${limit}`);
  }

  manual(): Promise<{ utcp_version: string; manual_version: string; tools: unknown[] }> {
    return this.request('/api/v1/manual');
  }

  validateManual(): Promise<{ ok: boolean; errors: string[]; warnings: string[]; toolCount: number }> {
    return this.request('/api/v1/manual/validate');
  }

  pairStart(): Promise<{ code: string; expiresAt: string }> {
    return this.request('/api/v1/pair/start', { method: 'POST' });
  }

  clients(): Promise<{ clients: Array<{ clientId: string; label: string; extensionId: string; createdAt: string; lastSeenAt: string | null; revoked: boolean }> }> {
    return this.request('/api/v1/clients');
  }

  revokeClient(clientId: string): Promise<{ ok: boolean }> {
    return this.request(`/api/v1/clients/${clientId}`, { method: 'DELETE' });
  }

  settings(patch: Record<string, unknown>): Promise<{ settings: RuntimeStatus['settings'] }> {
    return this.request('/api/v1/settings', { method: 'POST', body: JSON.stringify(patch) });
  }
}
