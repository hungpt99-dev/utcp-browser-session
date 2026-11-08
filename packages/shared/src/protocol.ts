/**
 * Wire protocol between the runtime, the extension and the provider.
 *
 * Every message is validated with zod before it is acted on, and every message
 * is size-capped by the transport. Adding an optional field is backwards
 * compatible; adding a message type is not, so both sides ship together.
 *
 * Identity model: a *domain* is identified by its full origin
 * (`scheme://host[:port]`). The hostname is the security check applied to every
 * request; the origin is the key that keeps two applications on the same host
 * (common on localhost) fully isolated from each other.
 */
import { z } from 'zod';
import type { JsonSchema, ShapeNode } from './schema.ts';

export const CALL_TEMPLATE_TYPE = 'utcp_browser_session';
export const MANUAL_VERSION = '1.0';
export const UTCP_VERSION = '1.0';

// ---------------------------------------------------------------------------
// Discovery shapes
// ---------------------------------------------------------------------------

const ShapeSchema: z.ZodType<ShapeNode> = z.lazy(() =>
  z.object({
    type: z.string().min(1).max(16),
    format: z.string().max(32).optional(),
    properties: z.record(ShapeSchema).optional(),
    items: ShapeSchema.optional(),
  }),
) as z.ZodType<ShapeNode>;

/** Guard against a malicious page sending a pathologically deep shape. */
export function shapeDepth(node: ShapeNode | undefined, depth = 0): number {
  if (!node) return depth;
  let max = depth;
  for (const child of Object.values(node.properties ?? {})) max = Math.max(max, shapeDepth(child, depth + 1));
  if (node.items) max = Math.max(max, shapeDepth(node.items, depth + 1));
  return max;
}

/** Coarse kind of an observed operation, decided from its shape and headers. */
export const EndpointKindSchema = z.enum(['rest', 'graphql', 'upload', 'download', 'stream', 'unknown']);

export const EndpointObservationSchema = z.object({
  /** Exact origin; the canonical identity of the site. */
  origin: z.string().min(4).max(300),
  method: z.string().min(1).max(16),
  path: z.string().min(1).max(2048),
  queryKeys: z.array(z.string().min(1).max(128)).max(64).default([]),
  status: z.number().int().min(100).max(599).optional(),
  contentType: z.string().max(160).optional(),
  requestShape: ShapeSchema.optional(),
  responseShape: ShapeSchema.optional(),
  source: z.enum(['webRequest', 'page-tap']),
  /** The tap saw a CSRF-ish header on this request (name only, never a value). */
  csrfHeaderSeen: z.boolean().optional(),
  /** GraphQL operation name, when the request body was a GraphQL envelope. */
  graphqlOperation: z.string().min(1).max(64).optional(),
  /**
   * Short, token-shaped value sets for enum-like fields. Only collected when the
   * user enables enum sampling; never contains free text, emails or secrets.
   */
  enums: z.record(z.array(z.string().min(1).max(24)).max(8)).optional(),
  requestBytes: z.number().int().min(0).max(64 * 1024 * 1024).optional(),
  responseBytes: z.number().int().min(0).max(64 * 1024 * 1024).optional(),
});
export type EndpointObservation = z.infer<typeof EndpointObservationSchema>;

// ---------------------------------------------------------------------------
// Extension -> runtime
// ---------------------------------------------------------------------------

export const HelloMessageSchema = z.object({
  type: z.literal('hello'),
  clientId: z.string().min(8).max(128),
  nonce: z.string().min(8).max(128),
  ts: z.number().int().positive(),
  signature: z.string().min(16).max(256),
  agent: z.string().max(64).optional(),
});

export const ResultMessageSchema = z.object({
  type: z.literal('result'),
  id: z.string().min(1).max(128),
  ok: z.boolean(),
  status: z.number().int().min(0).max(599),
  statusText: z.string().max(64).optional(),
  headers: z.record(z.string()).default({}),
  body: z.string().max(2 * 1024 * 1024).optional(),
  bodyEncoding: z.enum(['utf8', 'base64']).default('utf8'),
  latencyMs: z.number().min(0).max(600_000),
  truncated: z.boolean().default(false),
  redirectedTo: z.string().max(2048).optional(),
  error: z
    .object({
      code: z.string().max(64),
      message: z.string().max(2000),
      hint: z.string().max(600).optional(),
    })
    .optional(),
});

export const DiscoveryMessageSchema = z.object({
  type: z.literal('discovery'),
  events: z.array(EndpointObservationSchema).max(200),
});

export const StatusMessageSchema = z.object({
  type: z.literal('status'),
  capturing: z.array(z.string().max(300)).max(200),
  agent: z.string().max(64).optional(),
});

export const PongMessageSchema = z.object({
  type: z.literal('pong'),
  ts: z.number().int().positive(),
});

/**
 * User-initiated actions from the extension popup. The popup is not trusted
 * with the runtime token, so it asks the already-authenticated socket to act.
 */
export const IntentMessageSchema = z.object({
  type: z.literal('intent'),
  action: z.enum(['discovery_start', 'discovery_stop', 'enable_origin', 'disable_origin']),
  origin: z.string().min(4).max(300),
  deepCapture: z.boolean().optional(),
});

/**
 * Observed authentication state for one origin. The extension reports what the
 * website actually answered, which is the only reliable signal that a session
 * died — the runtime never sees a cookie.
 */
export const SessionMessageSchema = z.object({
  type: z.literal('session'),
  origin: z.string().min(4).max(300),
  status: z.enum(['ok', 'expired']),
  httpStatus: z.number().int().min(0).max(599),
  at: z.number().int().positive(),
});

/** Sent by the runtime immediately after the socket opens; the extension signs it. */
export const ChallengeMessageSchema = z.object({
  type: z.literal('challenge'),
  nonce: z.string().min(8).max(128),
  ts: z.number().int().positive(),
  runtime: z.string().max(64),
});

export const ExtensionMessageSchema = z.discriminatedUnion('type', [
  HelloMessageSchema,
  ResultMessageSchema,
  DiscoveryMessageSchema,
  StatusMessageSchema,
  PongMessageSchema,
  IntentMessageSchema,
  SessionMessageSchema,
]);
export type ExtensionMessage = z.infer<typeof ExtensionMessageSchema>;
export type HelloMessage = z.infer<typeof HelloMessageSchema>;
export type ResultMessage = z.infer<typeof ResultMessageSchema>;
export type DiscoveryMessage = z.infer<typeof DiscoveryMessageSchema>;
export type StatusMessage = z.infer<typeof StatusMessageSchema>;
export type IntentMessage = z.infer<typeof IntentMessageSchema>;
export type SessionMessage = z.infer<typeof SessionMessageSchema>;

// ---------------------------------------------------------------------------
// Runtime -> extension
// ---------------------------------------------------------------------------

export const ExecuteMessageSchema = z.object({
  type: z.literal('execute'),
  id: z.string().min(1).max(128),
  /** Correlation id shared by the provider, runtime, extension and audit log. */
  correlationId: z.string().min(1).max(64),
  method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']),
  url: z.string().min(1).max(2048),
  /** Origin the tool is bound to; the extension enforces it independently. */
  origin: z.string().min(4).max(300),
  headers: z.record(z.string().max(2048)).default({}),
  body: z.string().max(256 * 1024).optional(),
  timeoutMs: z.number().int().min(1000).max(120_000),
  csrf: z
    .object({
      bootstrapPath: z.string().min(1).max(512),
      tokenField: z.string().min(1).max(64),
      header: z.string().min(1).max(64),
    })
    .optional(),
});

export const CancelMessageSchema = z.object({
  type: z.literal('cancel'),
  id: z.string().min(1).max(128),
  reason: z.string().max(64).default('client_cancelled'),
});

export const DiscoveryStartSchema = z.object({
  type: z.literal('discovery_start'),
  origin: z.string().min(4).max(300),
  domain: z.string().min(1).max(253),
  deepCapture: z.boolean().default(false),
  captureEnums: z.boolean().default(false),
});

export const DiscoveryStopSchema = z.object({
  type: z.literal('discovery_stop'),
  origin: z.string().min(4).max(300),
});

export const SyncMessageSchema = z.object({
  type: z.literal('sync'),
  enabledOrigins: z.array(z.string().max(300)).max(200),
  deepCaptureOrigins: z.array(z.string().max(300)).max(200),
  enumCaptureOrigins: z.array(z.string().max(300)).max(200),
  /**
   * Origins the runtime currently considers under capture. Sent so a reconnect
   * cannot leave the extension recording into a runtime that dropped the state.
   */
  capturing: z.array(z.string().max(300)).max(200).default([]),
});

export const PingMessageSchema = z.object({ type: z.literal('ping'), ts: z.number().int().positive() });

export const RuntimeMessageSchema = z.discriminatedUnion('type', [
  ExecuteMessageSchema,
  CancelMessageSchema,
  DiscoveryStartSchema,
  DiscoveryStopSchema,
  SyncMessageSchema,
  PingMessageSchema,
]);
export type RuntimeMessage = z.infer<typeof RuntimeMessageSchema>;
export type ExecuteMessage = z.infer<typeof ExecuteMessageSchema>;
export type CancelMessage = z.infer<typeof CancelMessageSchema>;

/** Full set of frames the runtime can send (challenge is transport-level). */
export const RuntimeFrameSchema = z.discriminatedUnion('type', [
  ChallengeMessageSchema,
  ExecuteMessageSchema,
  CancelMessageSchema,
  DiscoveryStartSchema,
  DiscoveryStopSchema,
  SyncMessageSchema,
  PingMessageSchema,
]);
export type RuntimeFrame = z.infer<typeof RuntimeFrameSchema>;
export type ChallengeMessage = z.infer<typeof ChallengeMessageSchema>;

// ---------------------------------------------------------------------------
// REST payloads
// ---------------------------------------------------------------------------

export const PermissionLevelSchema = z.enum(['READ', 'WRITE', 'DESTRUCTIVE']);
export const ToolStatusSchema = z.enum(['draft', 'approved', 'revoked']);

export const PairClaimSchema = z.object({
  code: z.string().min(4).max(32),
  extensionId: z.string().min(8).max(128),
  label: z.string().max(64).optional(),
  /**
   * P-256 public key generated inside the extension. The runtime stores only
   * this public half, so a leaked state file cannot impersonate the browser.
   */
  publicKeyJwk: z.object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: z.string().min(10).max(200),
    y: z.string().min(10).max(200),
  }),
});

export const ExecuteRequestSchema = z.object({
  tool: z.string().min(1).max(200),
  args: z.record(z.unknown()).default({}),
  confirm: z.boolean().default(false),
  actor: z.enum(['utcp', 'dashboard', 'cli']).default('utcp'),
  /** Optional client-supplied correlation id; generated when absent. */
  correlationId: z.string().min(1).max(64).optional(),
});
export type ExecuteRequest = z.infer<typeof ExecuteRequestSchema>;

export const DomainInputSchema = z.object({
  domain: z.string().min(1).max(300),
  deepCapture: z.boolean().default(false),
  captureEnums: z.boolean().default(false),
  csrf: z
    .object({
      // `^/[^/]` forbids `//host:port`, which would leave the pinned origin.
      bootstrapPath: z.string().min(1).max(512).regex(/^\/[^/]/),
      tokenField: z.string().min(1).max(64),
      header: z.string().min(1).max(64).regex(/^[A-Za-z0-9-]+$/),
    })
    .optional(),
  policy: z
    .object({
      maxPermission: PermissionLevelSchema.optional(),
      confirmWrites: z.boolean().optional(),
      blockedPathPrefixes: z.array(z.string().max(200)).max(20).optional(),
    })
    .optional(),
});

export const ToolPatchSchema = z.object({
  name: z.string().min(1).max(60).regex(/^[a-z0-9_]+$/).optional(),
  description: z.string().min(1).max(600).optional(),
  permission: PermissionLevelSchema.optional(),
});

// ---------------------------------------------------------------------------
// Stored records
// ---------------------------------------------------------------------------

export interface CsrfConfig {
  bootstrapPath: string;
  tokenField: string;
  header: string;
}

/** Hard limits a domain imposes on every tool that belongs to it. */
export interface DomainPolicy {
  /** Highest permission this domain will ever grant, regardless of the tool. */
  maxPermission: 'READ' | 'WRITE' | 'DESTRUCTIVE';
  /** Require `__confirm` for every write, not only destructive ones. */
  confirmWrites: boolean;
  /** Path prefixes that must never become tools (e.g. `/admin`). */
  blockedPathPrefixes: string[];
}

export interface DomainSession {
  status: 'unknown' | 'ok' | 'expired';
  lastStatus: number | null;
  lastCheckedAt: string | null;
  lastErrorCode: string | null;
}

export interface DomainRecord {
  /** Canonical key: `scheme://host[:port]`. */
  origin: string;
  /** Hostname, used for the security check and for display. */
  domain: string;
  enabled: boolean;
  deepCapture: boolean;
  /** Collect short enum-like value sets for low-risk fields. */
  captureEnums: boolean;
  enabledAt: string | null;
  csrf?: CsrfConfig;
  policy: DomainPolicy;
  session: DomainSession;
  requestCount: number;
  lastSeenAt: string | null;
}

export interface PaginationInfo {
  style: 'page' | 'offset' | 'cursor';
  param: string;
  /** The response carries a total count. */
  hasTotal: boolean;
  /** Field holding the next cursor, when it exists. */
  nextField: string | null;
}

export interface DiscoveredEndpointRecord {
  /** `${origin} ${method} ${pathTemplate}` */
  key: string;
  origin: string;
  domain: string;
  method: string;
  pathTemplate: string;
  queryKeys: string[];
  pathParams: string[];
  contentType: string | null;
  statusCodes: number[];
  sampleCount: number;
  requestSchema: JsonSchema | null;
  responseSchema: JsonSchema | null;
  permission: 'READ' | 'WRITE' | 'DESTRUCTIVE';
  confident: boolean;
  classificationReason: string;
  kind: 'rest' | 'graphql' | 'upload' | 'download' | 'stream' | 'unknown';
  graphqlOperation: string | null;
  pagination: PaginationInfo | null;
  /** Observed a CSRF-style header on this request (name only). */
  csrfLikely: boolean;
  /** 0..1 — how much evidence supports this record. */
  confidence: number;
  signals: string[];
  sources: string[];
  blocked: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ToolRecord {
  id: string;
  name: string;
  fqName: string;
  manual: string;
  description: string;
  domain: string;
  origin: string;
  method: string;
  pathTemplate: string;
  paramLocations: Record<string, 'path' | 'query' | 'body'>;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  permission: 'READ' | 'WRITE' | 'DESTRUCTIVE';
  status: 'draft' | 'approved' | 'revoked';
  reviewRequired: boolean;
  kind: 'rest' | 'graphql' | 'upload' | 'download' | 'stream' | 'unknown';
  graphqlOperation: string | null;
  pagination: PaginationInfo | null;
  confidence: number;
  tags: string[];
  endpointKey: string;
  discovery: {
    sampleCount: number;
    sources: string[];
    firstSeenAt: string;
    statusCodes: number[];
    signals: string[];
  };
  createdAt: string;
  approvedAt: string | null;
  approvedBy: string | null;
  revokedAt: string | null;
  executionCount: number;
  lastExecutedAt: string | null;
  lastStatus: string | null;
}

export interface ExecutionRecord {
  id: string;
  correlationId: string;
  toolId: string;
  toolName: string;
  domain: string;
  origin: string;
  method: string;
  path: string;
  actor: 'utcp' | 'dashboard' | 'cli';
  outcome: 'ok' | 'error' | 'rejected' | 'timeout' | 'disconnected';
  httpStatus: number | null;
  latencyMs: number | null;
  queuedMs: number | null;
  startedAt: string;
  finishedAt: string | null;
  requestBytes: number | null;
  responseBytes: number | null;
  truncated: boolean;
  errorCode: string | null;
  errorCategory: 'policy' | 'validation' | 'auth' | 'transport' | 'upstream' | 'internal' | null;
  errorMessage: string | null;
  permission: 'READ' | 'WRITE' | 'DESTRUCTIVE';
  permissionDecision: 'allowed' | 'denied' | 'confirmation_required';
  approvalDecision: 'approved' | 'draft' | 'revoked' | 'n/a';
  /** Sanitized response body kept for the inspector, never headers. */
  responsePreview: string | null;
}

export type AuditSeverity = 'info' | 'warn' | 'error';

export interface AuditEvent {
  id: string;
  at: string;
  kind: string;
  severity: AuditSeverity;
  actor: 'utcp' | 'dashboard' | 'cli' | 'extension' | 'runtime';
  origin: string | null;
  toolName: string | null;
  correlationId: string | null;
  message: string;
  detail?: Record<string, unknown>;
  /** Hash chain: tampering with an entry breaks verification after it. */
  prevHash: string;
  hash: string;
}

export interface PairedClient {
  clientId: string;
  label: string;
  extensionId: string;
  /** Public half of the extension's key pair; the runtime never sees the private key. */
  publicKeyJwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export interface PairingCode {
  code: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

// ---------------------------------------------------------------------------
// Workflow proposals (Phase 6) — metadata only, never auto-executed
// ---------------------------------------------------------------------------

export interface WorkflowStep {
  toolId: string;
  toolName: string;
  /** Input of this step that is filled from a previous step's output. */
  bindings: Array<{ input: string; fromStep: number; outputPath: string }>;
  destructive: boolean;
}

export interface WorkflowProposal {
  id: string;
  name: string;
  summary: string;
  origin: string;
  domain: string;
  steps: WorkflowStep[];
  /** How many times this sequence was observed end to end. */
  occurrences: number;
  confidence: number;
  status: 'draft' | 'approved' | 'rejected';
  createdAt: string;
  approvedAt: string | null;
}

// ---------------------------------------------------------------------------
// Result envelope returned to a UTCP client
// ---------------------------------------------------------------------------

export interface ExecutionEnvelope {
  ok: boolean;
  tool: string;
  domain: string;
  origin: string;
  method: string;
  path: string;
  status: number;
  statusText?: string;
  headers: Record<string, string>;
  /** Parsed JSON when the response was JSON, raw text otherwise. */
  body: unknown;
  latencyMs: number;
  truncated: boolean;
  executionId: string;
  correlationId: string;
  pagination?: { next: string | null; total: number | null };
  error?: { code: string; message: string; hint?: string };
}
