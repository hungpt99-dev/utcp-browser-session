import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  REVIEW_THRESHOLD,
  UNSUPPORTED_KINDS,
  accumShape,
  accumToSchema,
  buildInputSchema,
  clampPermission,
  classifyPermission,
  describeEndpoint,
  detectKind,
  detectPagination,
  inferPathTemplate,
  isBlockedPath,
  redactString,
  redactValue,
  responseIsArray,
  sanitizeName,
  scoreConfidence,
  suggestToolName,
  type AuditEvent,
  type AuditSeverity,
  type DiscoveredEndpointRecord,
  type DomainPolicy,
  type DomainRecord,
  type EndpointObservation,
  type ExecutionRecord,
  type JsonSchema,
  type ParamLocation,
  type PairedClient,
  type PairingCode,
  type SchemaAccum,
  type ToolRecord,
  type WorkflowProposal,
} from '@utcp-browser-session/shared';
import { RUNTIME_DEFAULTS } from './config.ts';
import { generateId, generatePairingCode } from './token.ts';

export interface Settings {
  manualName: string;
  defaultTimeoutMs: number;
  maxResponseBytes: number;
  rateLimitPerMinute: number;
  /** Maximum browser calls in flight; further calls queue. */
  maxInFlight: number;
  /** Maximum queued calls before the runtime answers `busy`. */
  maxQueue: number;
}

export interface StateFile {
  version: 2;
  runtimeId: string;
  createdAt: string;
  settings: Settings;
  domains: DomainRecord[];
  endpoints: DiscoveredEndpointRecord[];
  tools: ToolRecord[];
  workflows: WorkflowProposal[];
  clients: PairedClient[];
  pairingCodes: PairingCode[];
  /** Head of the audit hash chain, survives log rotation. */
  auditHead: string;
}

/** A one-time, short-lived record that lets the extension pair without typing. */
export interface AutoPairRecord {
  code: string;
  createdAt: string;
  expiresAt: string;
  /** Bound to the first extension that reads it, so a replay from another id fails. */
  extensionId: string | null;
  claimedAt: string | null;
}

export interface AuditInput {
  kind: string;
  severity: AuditSeverity;
  actor: AuditEvent['actor'];
  origin?: string | null;
  toolName?: string | null;
  correlationId?: string | null;
  message: string;
  detail?: Record<string, unknown>;
}

const MAX_EXECUTIONS = 500;
const MAX_AUDITS = 2000;
const MAX_ENDPOINTS_PER_ORIGIN = 400;
const LOG_MAX_BYTES = 8 * 1024 * 1024;

const ENDPOINT_DEFAULTS: Partial<DiscoveredEndpointRecord> = {
  kind: 'rest',
  graphqlOperation: null,
  pagination: null,
  csrfLikely: false,
  confidence: 0.5,
  signals: [],
  blocked: false,
};

const TOOL_DEFAULTS: Partial<ToolRecord> = {
  kind: 'rest',
  graphqlOperation: null,
  pagination: null,
  confidence: 0.5,
  discovery: { sampleCount: 0, sources: [], firstSeenAt: '', statusCodes: [], signals: [] },
};

export const DEFAULT_POLICY: DomainPolicy = {
  maxPermission: 'DESTRUCTIVE',
  confirmWrites: false,
  blockedPathPrefixes: [],
};

function emptyState(): StateFile {
  return {
    version: 2,
    runtimeId: randomUUID(),
    createdAt: new Date().toISOString(),
    settings: {
      manualName: 'browser',
      defaultTimeoutMs: RUNTIME_DEFAULTS.defaultTimeoutMs,
      maxResponseBytes: RUNTIME_DEFAULTS.maxResponseBytes,
      rateLimitPerMinute: RUNTIME_DEFAULTS.rateLimitPerMinute,
      maxInFlight: RUNTIME_DEFAULTS.maxInFlight,
      maxQueue: RUNTIME_DEFAULTS.maxQueue,
    },
    domains: [],
    endpoints: [],
    tools: [],
    workflows: [],
    clients: [],
    pairingCodes: [],
    auditHead: 'genesis',
  };
}

/**
 * Append-only log for executions and audit events.
 *
 * These two streams are append-only and unbounded by nature, so writing them
 * into the state document meant rewriting the whole document several times per
 * tool call (measured: ~6.4 ms of blocking I/O per execution at 500 records).
 * An append is O(1) and survives a crash, and the file is rotated so it cannot
 * grow without limit.
 */
class EventLog<T> {
  private readonly file: string;
  private readonly rotateTo: string;

  constructor(file: string) {
    this.file = file;
    this.rotateTo = `${file}.1`;
  }

  append(entry: T): void {
    try {
      const stat = fs.statSync(this.file, { throwIfNoEntry: false });
      if (stat && stat.size > LOG_MAX_BYTES) fs.renameSync(this.file, this.rotateTo);
    } catch {
      /* rotation is best effort; a missing file is fine */
    }
    fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  /** Most recent entries first, bounded. */
  read(limit: number): T[] {
    const out: T[] = [];
    for (const file of [this.file, this.rotateTo]) {
      if (!fs.existsSync(file)) continue;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index].trim();
        if (!line) continue;
        try {
          out.push(JSON.parse(line) as T);
        } catch {
          /* a torn final line after a crash is skipped */
        }
        if (out.length >= limit) return out;
      }
    }
    return out;
  }
}

/**
 * All non-secret runtime metadata.
 *
 * The state document holds configuration (domains, tools, clients). The two
 * high-frequency append-only streams live in a separate log, and settings that
 * are cheap to recompute are written lazily, so a tool call does not pay for a
 * full document rewrite.
 */
export class Store {
  private state: StateFile;
  private readonly file: string;
  private readonly executions: EventLog<ExecutionRecord>;
  private readonly audits: EventLog<AuditEvent>;
  /**
   * Auto-pair material lives in memory only: a runtime restart invalidates it,
   * which is the fail-closed behaviour we want for a one-time credential.
   */
  private autoPair: AutoPairRecord | null = null;
  private executionCache: ExecutionRecord[] = [];
  private auditCache: AuditEvent[] = [];
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;

  private constructor(dataDir: string, state: StateFile) {
    this.state = state;
    this.file = path.join(dataDir, 'state.json');
    this.executions = new EventLog<ExecutionRecord>(path.join(dataDir, 'executions.ndjson'));
    this.audits = new EventLog<AuditEvent>(path.join(dataDir, 'audit.ndjson'));
  }

  static open(dataDir: string): Store {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(dataDir, 'state.json');
    const store = Store.load(dataDir, file);
    store.executionCache = store.executions.read(MAX_EXECUTIONS);
    store.auditCache = store.audits.read(MAX_AUDITS);
    store.flush();
    return store;
  }

  private static load(dataDir: string, file: string): Store {
    if (!fs.existsSync(file)) return new Store(dataDir, emptyState());

    const raw = fs.readFileSync(file, 'utf8');
    let parsed: Partial<StateFile> & { executions?: ExecutionRecord[]; audits?: AuditEvent[]; domains?: unknown[] };
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`State file ${file} is not valid JSON. Move it aside to start fresh.`);
    }

    const base = emptyState();
    const state: StateFile = {
      ...base,
      ...parsed,
      version: 2,
      settings: { ...base.settings, ...(parsed.settings ?? {}) },
      domains: (parsed.domains ?? []).map((domain) => Store.migrateDomain(domain)),
      endpoints: (parsed.endpoints ?? []).map((endpoint) => ({
        ...ENDPOINT_DEFAULTS,
        ...endpoint,
      })),
      tools: (parsed.tools ?? []).map((tool) => ({
        ...TOOL_DEFAULTS,
        ...tool,
      })),
      workflows: parsed.workflows ?? [],
      auditHead: parsed.auditHead ?? 'genesis',
    };

    // v1 kept executions and audits inline; re-import them once.
    const store = new Store(dataDir, state);
    for (const execution of (parsed.executions ?? []).slice().reverse()) store.executions.append(execution);
    for (const event of (parsed.audits ?? []).slice().reverse()) store.audits.append(event);
    return store;
  }

  /** v1 records were keyed by hostname; give every record its origin. */
  private static migrateDomain(input: unknown): DomainRecord {
    const record = input as Partial<DomainRecord> & { domain: string };
    const origin = record.origin ?? `https://${record.domain}`;
    return {
      origin,
      domain: record.domain,
      enabled: record.enabled ?? false,
      deepCapture: record.deepCapture ?? false,
      captureEnums: record.captureEnums ?? false,
      enabledAt: record.enabledAt ?? null,
      csrf: record.csrf,
      policy: { ...DEFAULT_POLICY, ...(record.policy ?? {}) },
      session: { status: 'unknown', lastStatus: null, lastCheckedAt: null, lastErrorCode: null, ...(record.session ?? {}) },
      requestCount: record.requestCount ?? 0,
      lastSeenAt: record.lastSeenAt ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

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
    if (patch.maxInFlight !== undefined) {
      this.state.settings.maxInFlight = Math.min(Math.max(patch.maxInFlight, 1), 32);
    }
    if (patch.maxQueue !== undefined) {
      this.state.settings.maxQueue = Math.min(Math.max(patch.maxQueue, 0), 200);
    }
    this.persistNow();
    return this.settings;
  }

  // -------------------------------------------------------------------------
  // Domains (keyed by origin)
  // -------------------------------------------------------------------------

  listDomains(): DomainRecord[] {
    return this.state.domains.map((domain) => ({ ...domain }));
  }

  getDomain(origin: string): DomainRecord | undefined {
    const found = this.state.domains.find((candidate) => candidate.origin === origin);
    return found ? { ...found } : undefined;
  }

  getDomainByHostname(domain: string): DomainRecord | undefined {
    const found = this.state.domains.find((candidate) => candidate.domain === domain);
    return found ? { ...found } : undefined;
  }

  isDomainEnabled(origin: string): boolean {
    return this.state.domains.some((candidate) => candidate.origin === origin && candidate.enabled);
  }

  enabledOrigins(): string[] {
    return this.state.domains.filter((domain) => domain.enabled).map((domain) => domain.origin);
  }

  deepCaptureOrigins(): string[] {
    return this.state.domains.filter((domain) => domain.enabled && domain.deepCapture).map((domain) => domain.origin);
  }

  enumCaptureOrigins(): string[] {
    return this.state.domains.filter((domain) => domain.enabled && domain.captureEnums).map((domain) => domain.origin);
  }

  enableDomain(
    origin: string,
    domain: string,
    options: {
      deepCapture?: boolean;
      captureEnums?: boolean;
      csrf?: DomainRecord['csrf'];
      policy?: Partial<DomainPolicy>;
    } = {},
  ): DomainRecord {
    const now = new Date().toISOString();
    const existing = this.state.domains.find((candidate) => candidate.origin === origin);
    if (existing) {
      existing.enabled = true;
      existing.enabledAt = existing.enabledAt ?? now;
      existing.deepCapture = options.deepCapture ?? existing.deepCapture;
      existing.captureEnums = options.captureEnums ?? existing.captureEnums;
      if (options.csrf !== undefined) existing.csrf = options.csrf;
      if (options.policy) existing.policy = { ...existing.policy, ...options.policy };
      this.persistNow();
      return { ...existing };
    }
    const record: DomainRecord = {
      origin,
      domain,
      enabled: true,
      deepCapture: options.deepCapture ?? false,
      captureEnums: options.captureEnums ?? false,
      enabledAt: now,
      csrf: options.csrf,
      policy: { ...DEFAULT_POLICY, ...(options.policy ?? {}) },
      session: { status: 'unknown', lastStatus: null, lastCheckedAt: null, lastErrorCode: null },
      requestCount: 0,
      lastSeenAt: null,
    };
    this.state.domains.push(record);
    this.persistNow();
    return { ...record };
  }

  updatePolicy(origin: string, policy: Partial<DomainPolicy>): DomainRecord | undefined {
    const existing = this.state.domains.find((candidate) => candidate.origin === origin);
    if (!existing) return undefined;
    existing.policy = { ...existing.policy, ...policy };
    // Tools are deliberately *not* relabelled: a WRITE operation relabelled READ
    // would still mutate the site while claiming to be safe. The ceiling is
    // enforced at execution time instead, where the call is refused outright.
    this.persistNow();
    return { ...existing };
  }

  /** Disabling a domain revokes every tool that belongs to it. */
  disableDomain(origin: string): boolean {
    const existing = this.state.domains.find((candidate) => candidate.origin === origin);
    if (!existing) return false;
    existing.enabled = false;
    existing.session = { ...existing.session, status: 'unknown' };
    this.state.tools = this.state.tools.map((tool) =>
      tool.origin === origin && tool.status !== 'revoked'
        ? { ...tool, status: 'revoked', revokedAt: new Date().toISOString() }
        : tool,
    );
    this.persistNow();
    return true;
  }

  /** Record what the website answered, so a dead session is visible. */
  setSession(origin: string, status: DomainRecord['session']['status'], httpStatus: number, errorCode: string | null): void {
    const existing = this.state.domains.find((candidate) => candidate.origin === origin);
    if (!existing) return;
    existing.session = {
      status,
      lastStatus: httpStatus,
      lastCheckedAt: new Date().toISOString(),
      lastErrorCode: errorCode,
    };
    this.persist();
  }

  touchDomain(origin: string): void {
    const existing = this.state.domains.find((candidate) => candidate.origin === origin);
    if (!existing) return;
    existing.requestCount += 1;
    existing.lastSeenAt = new Date().toISOString();
    this.persist();
  }

  // -------------------------------------------------------------------------
  // Endpoints
  // -------------------------------------------------------------------------

  listEndpoints(origin?: string): DiscoveredEndpointRecord[] {
    const items = origin ? this.state.endpoints.filter((endpoint) => endpoint.origin === origin) : this.state.endpoints;
    return items.map((endpoint) => ({ ...endpoint }));
  }

  getEndpoint(key: string): DiscoveredEndpointRecord | undefined {
    const found = this.state.endpoints.find((endpoint) => endpoint.key === key);
    return found ? { ...found } : undefined;
  }

  /**
   * Merge observations into the inventory.
   *
   * repeated observations of the same `METHOD /templated/path` on the same
   * origin widen the inferred schema (through the accumulator, which keeps
   * presence counts) instead of creating duplicates.
   */
  recordObservations(observations: EndpointObservation[]): number {
    let changed = 0;
    for (const observation of observations) {
      if (this.recordObservation(observation)) changed += 1;
    }
    if (changed > 0) this.persist();
    return changed;
  }

  /** Merge a single observation. Returns false when it was ignored. */
  recordObservation(observation: EndpointObservation): boolean {
    const origin = observation.origin;
    const domainRecord = this.state.domains.find((candidate) => candidate.origin === origin);
    if (!domainRecord || !domainRecord.enabled) return false;

    const method = observation.method.toUpperCase();
    const pathOnly = observation.path.split('?')[0] || '/';
    const { template, params } = inferPathTemplate(pathOnly);
    const key = `${origin} ${method} ${template}`;
    const now = new Date().toISOString();
    const kindInfo = detectKind({
      method,
      path: template,
      contentType: observation.contentType,
      requestShape: observation.requestShape,
    });

    const existing = this.state.endpoints.find((endpoint) => endpoint.key === key);
    const accum = (existing as (DiscoveredEndpointRecord & { accum?: { request: SchemaAccum | null; response: SchemaAccum | null } }) | undefined);

    if (existing && accum) {
      existing.sampleCount += 1;
      existing.lastSeenAt = now;
      existing.queryKeys = Array.from(new Set([...existing.queryKeys, ...observation.queryKeys])).slice(0, 64);
      if (observation.contentType && !existing.contentType) existing.contentType = observation.contentType;
      if (typeof observation.status === 'number' && !existing.statusCodes.includes(observation.status)) {
        existing.statusCodes = [...existing.statusCodes, observation.status].slice(-8);
      }
      if (!existing.sources.includes(observation.source)) existing.sources.push(observation.source);
      accum.accum = accum.accum ?? { request: null, response: null };
      if (observation.requestShape) {
        accum.accum.request = accumShape(accum.accum.request, observation.requestShape, observation.enums);
      }
      if (observation.responseShape) {
        accum.accum.response = accumShape(accum.accum.response, observation.responseShape, observation.enums);
      }
      if (observation.graphqlOperation) existing.graphqlOperation = observation.graphqlOperation;
      if (observation.csrfHeaderSeen) existing.csrfLikely = true;
      this.refreshDerived(existing, accum.accum);
      return true;
    }

    const created = {
      key,
      origin,
      domain: domainRecord.domain,
      method,
      pathTemplate: template,
      queryKeys: Array.from(new Set(observation.queryKeys)).slice(0, 64),
      pathParams: params,
      contentType: observation.contentType ?? null,
      statusCodes: typeof observation.status === 'number' ? [observation.status] : [],
      sampleCount: 1,
      requestSchema: null as JsonSchema | null,
      responseSchema: null as JsonSchema | null,
      permission: 'READ' as DiscoveredEndpointRecord['permission'],
      confident: false,
      classificationReason: '',
      kind: kindInfo.kind,
      graphqlOperation: observation.graphqlOperation ?? null,
      pagination: null,
      csrfLikely: observation.csrfHeaderSeen ?? false,
      confidence: 0,
      signals: [] as string[],
      sources: [observation.source],
      blocked: false,
      firstSeenAt: now,
      lastSeenAt: now,
      accum: {
        request: observation.requestShape ? accumShape(null, observation.requestShape, observation.enums) : null,
        response: observation.responseShape ? accumShape(null, observation.responseShape, observation.enums) : null,
      },
    } as DiscoveredEndpointRecord & { accum: { request: SchemaAccum | null; response: SchemaAccum | null } };

    this.refreshDerived(created, created.accum);

    this.state.endpoints.push(created);
    const perOrigin = this.state.endpoints.filter((endpoint) => endpoint.origin === origin);
    if (perOrigin.length > MAX_ENDPOINTS_PER_ORIGIN) {
      const oldest = perOrigin
        .slice()
        .sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt))
        .slice(0, perOrigin.length - MAX_ENDPOINTS_PER_ORIGIN);
      const drop = new Set(oldest.map((endpoint) => endpoint.key));
      this.state.endpoints = this.state.endpoints.filter((endpoint) => !drop.has(endpoint.key));
    }
    return true;
  }

  /** Recompute everything that is derived from the accumulators. */
  private refreshDerived(
    endpoint: DiscoveredEndpointRecord,
    accum: { request: SchemaAccum | null; response: SchemaAccum | null },
  ): void {
    if (accum.request) endpoint.requestSchema = accumToSchema(accum.request);
    if (accum.response) endpoint.responseSchema = accumToSchema(accum.response);

    const domainRecord = this.state.domains.find((candidate) => candidate.origin === endpoint.origin);
    const policy = domainRecord?.policy ?? DEFAULT_POLICY;
    endpoint.blocked = isBlockedPath(endpoint.pathTemplate, policy.blockedPathPrefixes);

    const classification = classifyPermission({
      method: endpoint.method,
      path: endpoint.pathTemplate,
      kind: endpoint.kind,
      operationName: endpoint.graphqlOperation,
      hasBody: Boolean(endpoint.requestSchema),
      responseIsArray: responseIsArray(endpoint.responseSchema),
    });
    endpoint.permission = clampPermission(classification.level, policy.maxPermission);
    endpoint.confident = classification.confident;
    endpoint.classificationReason = classification.reason;
    endpoint.signals = classification.signals;
    endpoint.pagination = detectPagination(endpoint.queryKeys, accum.response ? shapeOf(accum.response) : null);
    endpoint.confidence = scoreConfidence({
      sampleCount: endpoint.sampleCount,
      sources: endpoint.sources,
      hasRequestSchema: Boolean(endpoint.requestSchema),
      hasResponseSchema: Boolean(endpoint.responseSchema),
      classificationConfident: classification.confident,
      statusCodes: endpoint.statusCodes,
      kind: endpoint.kind,
    });
  }

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  listTools(filter: { status?: ToolRecord['status']; origin?: string; hostname?: string } = {}): ToolRecord[] {
    return this.state.tools
      .filter((tool) => (filter.status ? tool.status === filter.status : true))
      .filter((tool) => (filter.origin ? tool.origin === filter.origin : true))
      .filter((tool) => (filter.hostname ? tool.domain === filter.hostname : true))
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
  generateDrafts(origin: string, endpointKeys?: string[]): { created: ToolRecord[]; skipped: string[] } {
    const manual = this.state.settings.manualName;
    const domainRecord = this.state.domains.find((candidate) => candidate.origin === origin);
    const targets = this.state.endpoints.filter(
      (endpoint) => endpoint.origin === origin && (!endpointKeys || endpointKeys.includes(endpoint.key)),
    );
    const created: ToolRecord[] = [];
    const skipped: string[] = [];

    for (const endpoint of targets) {
      if (endpoint.blocked) {
        skipped.push(`${endpoint.key} (blocked by domain policy)`);
        continue;
      }
      if (UNSUPPORTED_KINDS.has(endpoint.kind)) {
        skipped.push(`${endpoint.key} (${endpoint.kind} is not executable through the extension yet)`);
        continue;
      }
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
        pagination: endpoint.pagination,
        graphqlOperation: endpoint.graphqlOperation,
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
        description: describeEndpoint(endpoint.method, endpoint.pathTemplate, endpoint.domain, endpoint.sampleCount),
        domain: endpoint.domain,
        origin: endpoint.origin,
        method: endpoint.method,
        pathTemplate: endpoint.pathTemplate,
        paramLocations: built.paramLocations as Record<string, ParamLocation>,
        inputSchema: built.schema,
        outputSchema: (endpoint.responseSchema as JsonSchema | null) ?? { type: 'object', additionalProperties: true },
        permission: endpoint.permission,
        status: 'draft',
        reviewRequired: !endpoint.confident || endpoint.confidence < REVIEW_THRESHOLD,
        kind: endpoint.kind,
        graphqlOperation: endpoint.graphqlOperation,
        pagination: endpoint.pagination,
        confidence: endpoint.confidence,
        tags: [endpoint.domain, endpoint.permission.toLowerCase(), endpoint.kind],
        endpointKey: endpoint.key,
        discovery: {
          sampleCount: endpoint.sampleCount,
          sources: [...endpoint.sources],
          firstSeenAt: endpoint.firstSeenAt,
          statusCodes: [...endpoint.statusCodes],
          signals: [...endpoint.signals],
        },
        createdAt: now,
        approvedAt: null,
        approvedBy: null,
        revokedAt: null,
        executionCount: 0,
        lastExecutedAt: null,
        lastStatus: null,
      };
      void domainRecord;
      this.state.tools.push(tool);
      created.push({ ...tool });
    }

    if (created.length) this.persistNow();
    return { created, skipped };
  }

  approveTool(id: string, actor: string): ToolRecord | undefined {
    const tool = this.state.tools.find((candidate) => candidate.id === id);
    if (!tool) return undefined;
    const domain = this.state.domains.find((candidate) => candidate.origin === tool.origin);
    if (!domain || !domain.enabled) return undefined;
    tool.status = 'approved';
    tool.approvedAt = new Date().toISOString();
    tool.approvedBy = actor;
    tool.revokedAt = null;
    this.persistNow();
    return { ...tool };
  }

  revokeTool(id: string, actor: string): ToolRecord | undefined {
    const tool = this.state.tools.find((candidate) => candidate.id === id);
    if (!tool) return undefined;
    tool.status = 'revoked';
    tool.revokedAt = new Date().toISOString();
    tool.approvedBy = actor;
    this.persistNow();
    return { ...tool };
  }

  updateTool(
    id: string,
    patch: { name?: string; description?: string; permission?: ToolRecord['permission'] },
  ): ToolRecord | undefined {
    const tool = this.state.tools.find((candidate) => candidate.id === id);
    if (!tool) return undefined;
    if (patch.name) {
      const clean = sanitizeName(patch.name);
      if (this.state.tools.some((other) => other.id !== id && other.fqName === `${tool.manual}.${clean}`)) return undefined;
      tool.name = clean;
      tool.fqName = `${tool.manual}.${clean}`;
    }
    if (patch.description) tool.description = patch.description;
    if (patch.permission) {
      const domain = this.state.domains.find((candidate) => candidate.origin === tool.origin);
      tool.permission = clampPermission(patch.permission, domain?.policy.maxPermission ?? 'DESTRUCTIVE');
    }
    this.persistNow();
    return { ...tool };
  }

  deleteTool(id: string): boolean {
    const before = this.state.tools.length;
    this.state.tools = this.state.tools.filter((tool) => tool.id !== id);
    if (this.state.tools.length === before) return false;
    this.persistNow();
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
    this.executionCache.unshift(record);
    if (this.executionCache.length > MAX_EXECUTIONS) this.executionCache.length = MAX_EXECUTIONS;
    this.executions.append(record);
  }

  listExecutions(limit = 50, toolId?: string): ExecutionRecord[] {
    const items = toolId ? this.executionCache.filter((execution) => execution.toolId === toolId) : this.executionCache;
    return items.slice(0, limit).map((execution) => ({ ...execution }));
  }

  audit(input: AuditInput): AuditEvent {
    const at = new Date().toISOString();
    const id = generateId('evt');
    // Redact at the persistence boundary, not at the call site: every audit
    // event is covered, including ones added later by new code paths.
    const message = redactString(input.message);
    const detail = input.detail ? (redactValue(input.detail) as Record<string, unknown>) : undefined;
    const prevHash = this.state.auditHead;
    const detailText = detail ? JSON.stringify(detail) : '';
    const hash = createHash('sha256')
      .update([prevHash, id, at, input.kind, input.severity, input.actor, input.origin ?? '', input.toolName ?? '', input.correlationId ?? '', message, detailText].join('|'))
      .digest('hex');

    const entry: AuditEvent = {
      id,
      at,
      kind: input.kind,
      severity: input.severity,
      actor: input.actor,
      origin: input.origin ?? null,
      toolName: input.toolName ?? null,
      correlationId: input.correlationId ?? null,
      message,
      detail,
      prevHash,
      hash,
    };

    this.state.auditHead = hash;
    this.auditCache.unshift(entry);
    if (this.auditCache.length > MAX_AUDITS) this.auditCache.length = MAX_AUDITS;
    this.audits.append(entry);
    this.persist();
    return entry;
  }

  listAudit(limit = 100, kind?: string): AuditEvent[] {
    const items = kind ? this.auditCache.filter((event) => event.kind === kind) : this.auditCache;
    return items.slice(0, limit).map((event) => ({ ...event }));
  }

  /**
   * Walk the hash chain over the events currently on disk. Rotation means the
   * oldest loaded event is the anchor: tampering after that point is detected.
   */
  verifyAudit(): { ok: boolean; checked: number; brokenAt: string | null } {
    const entries = this.audits.read(MAX_AUDITS).slice().reverse();
    let previous = entries[0]?.prevHash ?? 'genesis';
    let checked = 0;
    for (const entry of entries) {
      if (entry.prevHash !== previous) return { ok: false, checked, brokenAt: entry.id };
      const detail = entry.detail ? JSON.stringify(entry.detail) : '';
      const expected = createHash('sha256')
        .update([entry.prevHash, entry.id, entry.at, entry.kind, entry.severity, entry.actor, entry.origin ?? '', entry.toolName ?? '', entry.correlationId ?? '', entry.message, detail].join('|'))
        .digest('hex');
      if (expected !== entry.hash) return { ok: false, checked, brokenAt: entry.id };
      previous = entry.hash;
      checked += 1;
    }
    return { ok: true, checked, brokenAt: null };
  }

  // -------------------------------------------------------------------------
  // Workflow proposals
  // -------------------------------------------------------------------------

  listWorkflows(status?: WorkflowProposal['status']): WorkflowProposal[] {
    return this.state.workflows
      .filter((workflow) => (status ? workflow.status === status : true))
      .map((workflow) => ({ ...workflow }));
  }

  saveWorkflows(proposals: WorkflowProposal[]): void {
    for (const proposal of proposals) {
      const existing = this.state.workflows.find(
        (candidate) => candidate.origin === proposal.origin && candidate.name === proposal.name,
      );
      if (existing) {
        existing.occurrences = Math.max(existing.occurrences, proposal.occurrences);
        existing.confidence = Math.max(existing.confidence, proposal.confidence);
        existing.steps = proposal.steps;
      } else {
        this.state.workflows.push(proposal);
      }
    }
    if (proposals.length > 0) this.persistNow();
  }

  setWorkflowStatus(id: string, status: WorkflowProposal['status']): WorkflowProposal | undefined {
    const found = this.state.workflows.find((candidate) => candidate.id === id);
    if (!found) return undefined;
    found.status = status;
    found.approvedAt = status === 'approved' ? new Date().toISOString() : null;
    this.persistNow();
    return { ...found };
  }

  // -------------------------------------------------------------------------
  // Pairing / clients
  // -------------------------------------------------------------------------

  /** Create (or replace) the auto-pair record. Only called when `up` is running. */
  createAutoPair(ttlMs: number, expectedExtensionId: string | null = null): AutoPairRecord {
    const now = Date.now();
    this.autoPair = {
      code: generatePairingCode(),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
      // Bound at creation when the launcher knows the extension id; otherwise
      // bound to the first caller.
      extensionId: expectedExtensionId,
      claimedAt: null,
    };
    return { ...this.autoPair };
  }

  get hasAutoPair(): boolean {
    if (!this.autoPair) return false;
    return new Date(this.autoPair.expiresAt).getTime() > Date.now();
  }

  /**
   * Hand the auto-pair code to an extension, once.
   *
   * Refuses when the record is missing, expired, already consumed, or when a
   * different extension id asks for a record that was already bound to one.
   */
  takeAutoPair(extensionId: string): { ok: true; code: string; expiresAt: string } | { ok: false; reason: string } {
    const record = this.autoPair;
    if (!record) return { ok: false, reason: 'No auto-pairing is pending.' };
    if (record.claimedAt) return { ok: false, reason: 'This auto-pairing record was already used.' };
    if (new Date(record.expiresAt).getTime() <= Date.now()) {
      this.autoPair = null;
      return { ok: false, reason: 'This auto-pairing record has expired.' };
    }
    if (record.extensionId && record.extensionId !== extensionId) {
      // Same answer as "nothing pending": a probe cannot tell whether a record
      // exists or which extension it belongs to.
      return { ok: false, reason: 'No auto-pairing is pending.' };
    }
    record.extensionId = extensionId;
    record.claimedAt = new Date().toISOString();
    const code = record.code;
    const expiresAt = record.expiresAt;
    // The record cannot be read twice, but the code it carried still has to be
    // claimable by /pair/claim exactly once — that is the ECDSA key exchange.
    this.state.pairingCodes.push({ code, createdAt: record.createdAt, expiresAt, usedAt: null });
    this.persistNow();
    this.autoPair = null;
    return { ok: true, code, expiresAt };
  }

  createPairingCode(ttlMs: number): PairingCode {
    const now = Date.now();
    const code: PairingCode = {
      code: generatePairingCode(),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
      usedAt: null,
    };
    this.state.pairingCodes = this.state.pairingCodes.filter(
      (candidate) => !candidate.usedAt && new Date(candidate.expiresAt).getTime() > now,
    );
    this.state.pairingCodes.push(code);
    this.persistNow();
    return { ...code };
  }

  consumePairingCode(code: string): { ok: boolean; reason?: string } {
    const normalized = code.trim().toUpperCase();
    const found = this.state.pairingCodes.find((candidate) => candidate.code.toUpperCase() === normalized);
    if (!found) return { ok: false, reason: 'Unknown pairing code.' };
    if (found.usedAt) return { ok: false, reason: 'This pairing code has already been used.' };
    if (new Date(found.expiresAt).getTime() < Date.now()) return { ok: false, reason: 'This pairing code has expired.' };
    found.usedAt = new Date().toISOString();
    this.persistNow();
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
    this.persistNow();
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
    this.persistNow();
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
      executions: this.executionCache.length,
      clients: this.state.clients.filter((client) => !client.revokedAt).length,
      workflows: this.state.workflows.length,
      expiredSessions: this.state.domains.filter((domain) => domain.session.status === 'expired').length,
    };
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /** Coalesce many small mutations into one write. */
  private persist(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 15);
    this.timer.unref?.();
  }

  /** Write immediately; used for anything security-relevant. */
  private persistNow(): void {
    this.dirty = true;
    this.flush();
  }

  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    // The data directory can disappear under a test harness or uninstall;
    // losing a debounced counter write is preferable to throwing from a timer.
    if (!fs.existsSync(path.dirname(this.file))) return;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  close(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flush();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert an accumulator back to the shape the pagination detector expects. */
function shapeOf(accum: SchemaAccum): { type: string; properties?: Record<string, { type: string }> } | null {
  if (!accum.props) return null;
  const properties: Record<string, { type: string }> = {};
  for (const [key, child] of Object.entries(accum.props)) {
    properties[key] = { type: child.types.find((type) => type !== 'null') ?? 'null' };
  }
  return { type: accum.types[0] ?? 'object', properties };
}

