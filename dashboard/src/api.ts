import type {
  AuditEvent,
  DiscoveredEndpointRecord,
  DomainRecord,
  ExecutionRecord,
  ToolRecord,
  WorkflowProposal,
} from '@utcp-browser-session/shared';

export interface RuntimeStatus {
  ok: boolean;
  runtimeId: string;
  version: string;
  connection: {
    connected: boolean;
    client: { clientId: string; label: string; connectedAt: string } | null;
    capturing: string[];
    counters: {
      discoveryFrames: number;
      observationsIngested: number;
      observationsDropped: number;
      resultsReceived: number;
      callsQueued: number;
      callsRejectedBusy: number;
      cancellations: number;
      sessionExpiredReports: number;
    };
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
    workflows: number;
    expiredSessions: number;
  };
  settings: {
    manualName: string;
    defaultTimeoutMs: number;
    maxResponseBytes: number;
    rateLimitPerMinute: number;
    maxInFlight: number;
    maxQueue: number;
  };
  tokenVariable: string;
}

export interface Metrics {
  browserLatencyMs: { count: number; p50: number; p95: number; p99: number; max: number };
  queueWaitMs: { count: number; p50: number; p95: number; p99: number; max: number };
  inFlight: number;
  queued: number;
  counters: RuntimeStatus['connection']['counters'];
  memory: number;
  uptimeSeconds: number;
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

  metrics(): Promise<Metrics> {
    return this.request<Metrics>('/api/v1/metrics');
  }

  domains(): Promise<{ domains: DomainSummary[] }> {
    return this.request('/api/v1/domains');
  }

  addDomain(input: {
    domain: string;
    deepCapture: boolean;
    captureEnums?: boolean;
    csrf?: { bootstrapPath: string; tokenField: string; header: string };
    policy?: { maxPermission?: 'READ' | 'WRITE' | 'DESTRUCTIVE'; confirmWrites?: boolean; blockedPathPrefixes?: string[] };
  }): Promise<{ domain: DomainRecord }> {
    return this.request('/api/v1/domains', { method: 'POST', body: JSON.stringify(input) });
  }

  patchDomain(
    origin: string,
    patch: {
      deepCapture?: boolean;
      captureEnums?: boolean;
      policy?: { maxPermission?: 'READ' | 'WRITE' | 'DESTRUCTIVE'; confirmWrites?: boolean; blockedPathPrefixes?: string[] };
    },
  ): Promise<{ domain: DomainRecord }> {
    return this.request(`/api/v1/domains/${encodeURIComponent(origin)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  removeDomain(origin: string): Promise<{ ok: boolean }> {
    return this.request(`/api/v1/domains/${encodeURIComponent(origin)}`, { method: 'DELETE' });
  }

  startDiscovery(origin: string): Promise<{ ok: boolean }> {
    return this.request(`/api/v1/domains/${encodeURIComponent(origin)}/discovery`, { method: 'POST' });
  }

  stopDiscovery(origin: string): Promise<{ ok: boolean }> {
    return this.request(`/api/v1/domains/${encodeURIComponent(origin)}/discovery`, { method: 'DELETE' });
  }

  endpoints(origin?: string): Promise<{ endpoints: DiscoveredEndpointRecord[] }> {
    return this.request(`/api/v1/endpoints${origin ? `?origin=${encodeURIComponent(origin)}` : ''}`);
  }

  tools(status?: string, origin?: string): Promise<{ tools: ToolRecord[] }> {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (origin) params.set('origin', origin);
    const query = params.toString();
    return this.request(`/api/v1/tools${query ? `?${query}` : ''}`);
  }

  generate(origin: string, endpointKeys?: string[]): Promise<{ created: ToolRecord[]; skipped: string[] }> {
    return this.request('/api/v1/tools/generate', {
      method: 'POST',
      body: JSON.stringify({ origin, endpointKeys }),
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

  patchTool(
    id: string,
    patch: { name?: string; description?: string; permission?: 'READ' | 'WRITE' | 'DESTRUCTIVE' },
  ): Promise<{ tool: ToolRecord }> {
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

  verifyAudit(): Promise<{ ok: boolean; checked: number; brokenAt: string | null }> {
    return this.request('/api/v1/audit/verify');
  }

  workflows(status?: string): Promise<{ workflows: WorkflowProposal[] }> {
    return this.request(`/api/v1/workflows${status ? `?status=${status}` : ''}`);
  }

  discoverWorkflows(): Promise<{ proposals: WorkflowProposal[]; total: number }> {
    return this.request('/api/v1/workflows/discover', { method: 'POST' });
  }

  setWorkflowStatus(id: string, action: 'approve' | 'reject'): Promise<{ workflow: WorkflowProposal }> {
    return this.request(`/api/v1/workflows/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
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
