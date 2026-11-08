import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  buildInputSchema,
  classifyPermission,
  describeEndpoint,
  inferPathTemplate,
  isLoopbackDomain,
  mergeJsonSchema,
  sanitizeName,
  shapeToJsonSchema,
  suggestToolName,
  type JsonSchema,
  type ParamLocation,
} from '@utcp-browser-session/shared';
import type {
  AuditEvent,
  DiscoveredEndpointRecord,
  DomainRecord,
  EndpointObservation,
  ExecutionRecord,
  PairedClient,
  PairingCode,
  ToolRecord,
} from '@utcp-browser-session/shared';
import { RUNTIME_DEFAULTS } from './config.ts';
import { generateId, generatePairingCode } from './token.ts';

export interface Settings {
  manualName: string;
  defaultTimeoutMs: number;
  maxResponseBytes: number;
  rateLimitPerMinute: number;
}

export interface StateFile {
  version: 1;
  runtimeId: string;
  createdAt: string;
  settings: Settings;
  domains: DomainRecord[];
  endpoints: DiscoveredEndpointRecord[];
  tools: ToolRecord[];
  executions: ExecutionRecord[];
  audits: AuditEvent[];
  clients: PairedClient[];
  pairingCodes: PairingCode[];
}

const MAX_EXECUTIONS = 500;
const MAX_AUDITS = 2000;
const MAX_ENDPOINTS_PER_DOMAIN = 400;

function emptyState(): StateFile {
  return {
    version: 1,
    runtimeId: randomUUID(),
    createdAt: new Date().toISOString(),
    settings: {
      manualName: 'browser',
      defaultTimeoutMs: RUNTIME_DEFAULTS.defaultTimeoutMs,
      maxResponseBytes: RUNTIME_DEFAULTS.maxResponseBytes,
      rateLimitPerMinute: RUNTIME_DEFAULTS.rateLimitPerMinute,
    },
    domains: [],
    endpoints: [],
    tools: [],
    executions: [],
    audits: [],
    clients: [],
    pairingCodes: [],
  };
}

/**
 * All non-secret runtime metadata, persisted as one JSON document.
 *
 * A single small document keeps the deployment story simple (no database, no
 * migrations, no native module) and makes the audit trail trivial to inspect.
 * Writes are atomic (temp file + rename) so a crash cannot truncate state.
 */
export class Store {
  private state: StateFile;
  private readonly file: string;

  private constructor(dataDir: string, state: StateFile) {
    this.state = state;
    this.file = path.join(dataDir, 'state.json');
  }

  static open(dataDir: string): Store {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(dataDir, 'state.json');
    if (!fs.existsSync(file)) {
      const store = new Store(dataDir, emptyState());
      store.persist();
      return store;
    }
    const raw = fs.readFileSync(file, 'utf8');
    let parsed: StateFile;
    try {
      parsed = JSON.parse(raw) as StateFile;
    } catch {
      throw new Error(`State file ${file} is not valid JSON. Move it aside to start fresh.`);
    }
    const base = emptyState();
    const merged: StateFile = {
      ...base,
      ...parsed,
      settings: { ...base.settings, ...(parsed.settings ?? {}) },
    };
    return new Store(dataDir, merged);
  }

  get settings(): Settings {
    return { ...this.state.settings };
  }

  get runtimeId(): string {
    return this.state.runtimeId;
  }

  updateSettings(patch: Partial<Settings>): Settings {
    if (patch.manualName !== undefined) {
      const clean = sanitizeName(patch.manualName);
      this.state.settings.manualName = clean || 'browser';
    }
    if (patch.defaultTimeoutMs !== undefined) {
      this.state.settings.defaultTimeoutMs = Math.min(Math.max(patch.defaultTimeoutMs, 1000), 120_000);
    }
    if (patch.maxResponseBytes !== undefined) {
      this.state.settings.maxResponseBytes = Math.min(Math.max(patch.maxResponseBytes, 1024), 8 * 1024 * 1024);
    }
    if (patch.rateLimitPerMinute !== undefined) {
      this.state.settings.rateLimitPerMinute = Math.min(Math.max(patch.rateLimitPerMinute, 1), 600);
    }
    this.persist();
    return this.settings;
  }

  // -------------------------------------------------------------------------
  // Domains
  // -------------------------------------------------------------------------

  listDomains(): DomainRecord[] {
    return this.state.domains.map((domain) => ({ ...domain }));
  }

  getDomain(domain: string): DomainRecord | undefined {
    const found = this.state.domains.find((candidate) => candidate.domain === domain);
    return found ? { ...found } : undefined;
  }

  isDomainEnabled(domain: string): boolean {
    return this.state.domains.some((candidate) => candidate.domain === domain && candidate.enabled);
  }

  enableDomain(
    domain: string,
    options: { origin?: string; deepCapture?: boolean; csrf?: DomainRecord['csrf'] } = {},
  ): DomainRecord {
    const existing = this.state.domains.find((candidate) => candidate.domain === domain);
    const now = new Date().toISOString();
    const origin = options.origin ?? (isLoopbackDomain(domain) ? `http://${domain}` : `https://${domain}`);
    if (existing) {
      existing.enabled = true;
      existing.enabledAt = existing.enabledAt ?? now;
      existing.origin = origin;
      existing.deepCapture = options.deepCapture ?? existing.deepCapture;
      if (options.csrf !== undefined) existing.csrf = options.csrf;
      this.persist();
      return { ...existing };
    }
    const record: DomainRecord = {
      domain,
      origin,
      enabled: true,
      deepCapture: options.deepCapture ?? false,
      enabledAt: now,
      csrf: options.csrf,
      requestCount: 0,
      lastSeenAt: null,
    };
    this.state.domains.push(record);
    this.persist();
    return { ...record };
  }

  disableDomain(domain: string): boolean {
    const existing = this.state.domains.find((candidate) => candidate.domain === domain);
    if (!existing) return false;
    existing.enabled = false;
    this.state.tools = this.state.tools.map((tool) =>
      tool.domain === domain && tool.status !== 'revoked'
        ? { ...tool, status: 'revoked', revokedAt: new Date().toISOString() }
        : tool,
    );
    this.persist();
    return true;
  }

  touchDomain(domain: string): void {
    const existing = this.state.domains.find((candidate) => candidate.domain === domain);
    if (!existing) return;
    existing.requestCount += 1;
    existing.lastSeenAt = new Date().toISOString();
    this.persist();
  }

  // -------------------------------------------------------------------------
  // Endpoints
  // -------------------------------------------------------------------------

  listEndpoints(domain?: string): DiscoveredEndpointRecord[] {
    const items = domain ? this.state.endpoints.filter((endpoint) => endpoint.domain === domain) : this.state.endpoints;
    return items.map((endpoint) => ({ ...endpoint }));
  }

  getEndpoint(domain: string, key: string): DiscoveredEndpointRecord | undefined {
    const found = this.state.endpoints.find((endpoint) => endpoint.domain === domain && endpoint.key === key);
    return found ? { ...found } : undefined;
  }

  /**
   * Merge one observation into the inventory.
   *
   * Repeated observations of the same `METHOD /templated/path` widen the
   * inferred schema and bump the sample count instead of creating duplicates.
   */
  recordObservation(observation: EndpointObservation): DiscoveredEndpointRecord {
    const domain = observation.domain;
    const method = observation.method.toUpperCase();
    const pathOnly = observation.path.split('?')[0] || '/';
    const { template, params } = inferPathTemplate(pathOnly);
    const key = `${method} ${template}`;
    const now = new Date().toISOString();

    const requestSchema = observation.requestShape ? shapeToJsonSchema(observation.requestShape) : null;
    const responseSchema = observation.responseShape ? shapeToJsonSchema(observation.responseShape) : null;

    const existing = this.state.endpoints.find((endpoint) => endpoint.domain === domain && endpoint.key === key);
    if (existing) {
      existing.sampleCount += 1;
      existing.lastSeenAt = now;
      existing.queryKeys = Array.from(new Set([...existing.queryKeys, ...observation.queryKeys])).slice(0, 64);
      if (observation.contentType && !existing.contentType) existing.contentType = observation.contentType;
      if (typeof observation.status === 'number' && !existing.statusCodes.includes(observation.status)) {
        existing.statusCodes = [...existing.statusCodes, observation.status].slice(-8);
      }
      if (requestSchema) existing.requestSchema = mergeJsonSchema(existing.requestSchema ?? {}, requestSchema);
      if (responseSchema) existing.responseSchema = mergeJsonSchema(existing.responseSchema ?? {}, responseSchema);
      if (!existing.sources.includes(observation.source)) existing.sources.push(observation.source);
      this.persist();
      return { ...existing };
    }

    const classification = classifyPermission(method, template);
    const record: DiscoveredEndpointRecord = {
      key,
      domain,
      method,
      pathTemplate: template,
      queryKeys: Array.from(new Set(observation.queryKeys)).slice(0, 64),
      pathParams: params,
      contentType: observation.contentType ?? null,
      statusCodes: typeof observation.status === 'number' ? [observation.status] : [],
      sampleCount: 1,
      requestSchema,
      responseSchema,
      permission: classification.level,
      confident: classification.confident,
      classificationReason: classification.reason,
      sources: [observation.source],
      firstSeenAt: now,
      lastSeenAt: now,
    };
    this.state.endpoints.push(record);

    const perDomain = this.state.endpoints.filter((endpoint) => endpoint.domain === domain);
    if (perDomain.length > MAX_ENDPOINTS_PER_DOMAIN) {
      this.state.endpoints = this.state.endpoints.filter(
        (endpoint) => endpoint.domain !== domain || endpoint !== record,
      );
    }
    this.persist();
    return { ...record };
  }

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  listTools(filter: { status?: ToolRecord['status']; domain?: string } = {}): ToolRecord[] {
    return this.state.tools
      .filter((tool) => (filter.status ? tool.status === filter.status : true))
      .filter((tool) => (filter.domain ? tool.domain === filter.domain : true))
      .map((tool) => ({ ...tool }));
  }

  getTool(id: string): ToolRecord | undefined {
    const found = this.state.tools.find((tool) => tool.id === id);
    return found ? { ...found } : undefined;
  }

  getToolByFqName(fqName: string): ToolRecord | undefined {
    const found = this.state.tools.find((tool) => tool.fqName === fqName || tool.name === fqName);
    return found ? { ...found } : undefined;
  }

  /** Create draft tools from discovered endpoints. Nothing becomes callable. */
  generateDrafts(domain: string, endpointKeys?: string[]): { created: ToolRecord[]; skipped: string[] } {
    const manual = this.state.settings.manualName;
    const targets = this.state.endpoints.filter(
      (endpoint) => endpoint.domain === domain && (!endpointKeys || endpointKeys.includes(endpoint.key)),
    );
    const created: ToolRecord[] = [];
    const skipped: string[] = [];

    for (const endpoint of targets) {
      const already = this.state.tools.find((tool) => tool.endpointKey === endpoint.key && tool.status !== 'revoked');
      if (already) {
        skipped.push(`${endpoint.key} (already has tool "${already.fqName}")`);
        continue;
      }
      const built = buildInputSchema({
        method: endpoint.method,
        pathTemplate: endpoint.pathTemplate,
        queryKeys: endpoint.queryKeys,
        bodySchema: endpoint.requestSchema ?? undefined,
      });
      const baseName = suggestToolName(endpoint.method, endpoint.pathTemplate);
      let name = baseName;
      let suffix = 2;
      while (this.state.tools.some((tool) => tool.manual === manual && tool.name === name)) {
        name = `${baseName}_${suffix}`;
        suffix += 1;
      }

      const now = new Date().toISOString();
      const tool: ToolRecord = {
        id: generateId('tool'),
        name,
        fqName: `${manual}.${name}`,
        manual,
        description: describeEndpoint(endpoint.method, endpoint.pathTemplate, domain, endpoint.sampleCount),
        domain,
        method: endpoint.method,
        pathTemplate: endpoint.pathTemplate,
        paramLocations: built.paramLocations as Record<string, ParamLocation>,
        inputSchema: built.schema,
        outputSchema: (endpoint.responseSchema as JsonSchema | null) ?? { type: 'object', additionalProperties: true },
        permission: endpoint.permission,
        status: 'draft',
        reviewRequired: !endpoint.confident,
        tags: [domain, endpoint.permission.toLowerCase()],
        endpointKey: endpoint.key,
        discovery: {
          sampleCount: endpoint.sampleCount,
          sources: [...endpoint.sources],
          firstSeenAt: endpoint.firstSeenAt,
          statusCodes: [...endpoint.statusCodes],
        },
        createdAt: now,
        approvedAt: null,
        approvedBy: null,
        revokedAt: null,
        executionCount: 0,
        lastExecutedAt: null,
        lastStatus: null,
      };
      this.state.tools.push(tool);
      created.push({ ...tool });
    }

    if (created.length) this.persist();
    return { created, skipped };
  }

  approveTool(id: string, actor: string): ToolRecord | undefined {
    const tool = this.state.tools.find((candidate) => candidate.id === id);
    if (!tool) return undefined;
    const domain = this.state.domains.find((candidate) => candidate.domain === tool.domain);
    if (!domain || !domain.enabled) return undefined;
    tool.status = 'approved';
    tool.approvedAt = new Date().toISOString();
    tool.approvedBy = actor;
    tool.revokedAt = null;
    this.persist();
    return { ...tool };
  }

  revokeTool(id: string, actor: string): ToolRecord | undefined {
    const tool = this.state.tools.find((candidate) => candidate.id === id);
    if (!tool) return undefined;
    tool.status = 'revoked';
    tool.revokedAt = new Date().toISOString();
    tool.approvedBy = actor;
    this.persist();
    return { ...tool };
  }

  updateTool(id: string, patch: { name?: string; description?: string }): ToolRecord | undefined {
    const tool = this.state.tools.find((candidate) => candidate.id === id);
    if (!tool) return undefined;
    if (patch.name) {
      const clean = sanitizeName(patch.name);
      if (this.state.tools.some((other) => other.id !== id && other.fqName === `${tool.manual}.${clean}`)) return undefined;
      tool.name = clean;
      tool.fqName = `${tool.manual}.${clean}`;
    }
    if (patch.description) tool.description = patch.description;
    this.persist();
    return { ...tool };
  }

  deleteTool(id: string): boolean {
    const before = this.state.tools.length;
    this.state.tools = this.state.tools.filter((tool) => tool.id !== id);
    if (this.state.tools.length === before) return false;
    this.persist();
    return true;
  }

  noteToolExecution(id: string, status: string): void {
    const tool = this.state.tools.find((candidate) => candidate.id === id);
    if (!tool) return;
    tool.executionCount += 1;
    tool.lastExecutedAt = new Date().toISOString();
    tool.lastStatus = status;
    this.persist();
  }

  // -------------------------------------------------------------------------
  // Executions and audit
  // -------------------------------------------------------------------------

  addExecution(record: ExecutionRecord): void {
    this.state.executions.unshift(record);
    if (this.state.executions.length > MAX_EXECUTIONS) this.state.executions.length = MAX_EXECUTIONS;
    this.persist();
  }

  listExecutions(limit = 50, toolId?: string): ExecutionRecord[] {
    const items = toolId ? this.state.executions.filter((execution) => execution.toolId === toolId) : this.state.executions;
    return items.slice(0, limit).map((execution) => ({ ...execution }));
  }

  audit(event: Omit<AuditEvent, 'id' | 'at'>): AuditEvent {
    const entry: AuditEvent = { id: generateId('evt'), at: new Date().toISOString(), ...event };
    this.state.audits.unshift(entry);
    if (this.state.audits.length > MAX_AUDITS) this.state.audits.length = MAX_AUDITS;
    this.persist();
    return entry;
  }

  listAudit(limit = 100, kind?: string): AuditEvent[] {
    const items = kind ? this.state.audits.filter((event) => event.kind === kind) : this.state.audits;
    return items.slice(0, limit).map((event) => ({ ...event }));
  }

  // -------------------------------------------------------------------------
  // Pairing / clients
  // -------------------------------------------------------------------------

  createPairingCode(ttlMs: number): PairingCode {
    const now = Date.now();
    const code: PairingCode = {
      code: generatePairingCode(),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
      usedAt: null,
    };
    this.state.pairingCodes = this.state.pairingCodes.filter((candidate) => !candidate.usedAt && new Date(candidate.expiresAt).getTime() > now);
    this.state.pairingCodes.push(code);
    this.persist();
    return { ...code };
  }

  consumePairingCode(code: string): { ok: boolean; reason?: string } {
    const normalized = code.trim().toUpperCase();
    const found = this.state.pairingCodes.find((candidate) => candidate.code.toUpperCase() === normalized);
    if (!found) return { ok: false, reason: 'Unknown pairing code.' };
    if (found.usedAt) return { ok: false, reason: 'This pairing code has already been used.' };
    if (new Date(found.expiresAt).getTime() < Date.now()) return { ok: false, reason: 'This pairing code has expired.' };
    found.usedAt = new Date().toISOString();
    this.persist();
    return { ok: true };
  }

  createClient(input: {
    extensionId: string;
    label: string;
    publicKeyJwk: PairedClient['publicKeyJwk'];
  }): PairedClient {
    const client: PairedClient = {
      clientId: generateId('ext'),
      label: input.label.slice(0, 64) || 'Chrome extension',
      extensionId: input.extensionId,
      publicKeyJwk: input.publicKeyJwk,
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
      revokedAt: null,
    };
    this.state.clients.push(client);
    this.persist();
    return { ...client };
  }

  getClient(clientId: string): PairedClient | undefined {
    const found = this.state.clients.find((candidate) => candidate.clientId === clientId);
    return found ? { ...found } : undefined;
  }

  listClients(): PairedClient[] {
    return this.state.clients.map((client) => ({ ...client }));
  }

  touchClient(clientId: string): void {
    const found = this.state.clients.find((candidate) => candidate.clientId === clientId);
    if (!found) return;
    found.lastSeenAt = new Date().toISOString();
    this.persist();
  }

  revokeClient(clientId: string): boolean {
    const found = this.state.clients.find((candidate) => candidate.clientId === clientId);
    if (!found) return false;
    found.revokedAt = new Date().toISOString();
    this.persist();
    return true;
  }

  stats() {
    return {
      domains: this.state.domains.length,
      enabledDomains: this.state.domains.filter((domain) => domain.enabled).length,
      endpoints: this.state.endpoints.length,
      tools: this.state.tools.length,
      approved: this.state.tools.filter((tool) => tool.status === 'approved').length,
      drafts: this.state.tools.filter((tool) => tool.status === 'draft').length,
      revoked: this.state.tools.filter((tool) => tool.status === 'revoked').length,
      executions: this.state.executions.length,
      clients: this.state.clients.filter((client) => !client.revokedAt).length,
    };
  }

  private persist(): void {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
