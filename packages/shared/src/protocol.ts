/**
 * Wire protocol between the runtime, the extension and the provider.
 *
 * Every message is validated with zod before it is acted on, and every message
 * is size-capped by the transport. Adding a field is backwards compatible;
 * adding a message type is not, so both sides ship together.
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

export const EndpointObservationSchema = z.object({
  domain: z.string().min(1).max(253),
  method: z.string().min(1).max(16),
  path: z.string().min(1).max(2048),
  queryKeys: z.array(z.string().min(1).max(128)).max(64).default([]),
  status: z.number().int().min(100).max(599).optional(),
  contentType: z.string().max(160).optional(),
  requestShape: ShapeSchema.optional(),
  responseShape: ShapeSchema.optional(),
  source: z.enum(['webRequest', 'page-tap']),
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
  enabledDomains: z.array(z.string().max(253)).max(200),
  capturing: z.array(z.string().max(253)).max(200),
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
  action: z.enum(['discovery_start', 'discovery_stop', 'enable_domain', 'disable_domain']),
  domain: z.string().min(1).max(253),
  deepCapture: z.boolean().optional(),
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
]);
export type ExtensionMessage = z.infer<typeof ExtensionMessageSchema>;
export type HelloMessage = z.infer<typeof HelloMessageSchema>;
export type ResultMessage = z.infer<typeof ResultMessageSchema>;
export type DiscoveryMessage = z.infer<typeof DiscoveryMessageSchema>;
export type StatusMessage = z.infer<typeof StatusMessageSchema>;
export type IntentMessage = z.infer<typeof IntentMessageSchema>;

// ---------------------------------------------------------------------------
// Runtime -> extension
// ---------------------------------------------------------------------------

export const ExecuteMessageSchema = z.object({
  type: z.literal('execute'),
  id: z.string().min(1).max(128),
  method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']),
  url: z.string().min(1).max(2048),
  domain: z.string().min(1).max(253),
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

export const DiscoveryStartSchema = z.object({
  type: z.literal('discovery_start'),
  domain: z.string().min(1).max(253),
  deepCapture: z.boolean().default(false),
});

export const DiscoveryStopSchema = z.object({
  type: z.literal('discovery_stop'),
  domain: z.string().min(1).max(253),
});

export const SyncMessageSchema = z.object({
  type: z.literal('sync'),
  enabledDomains: z.array(z.string().max(253)).max(200),
  deepCapture: z.array(z.string().max(253)).max(200),
});

export const PingMessageSchema = z.object({ type: z.literal('ping'), ts: z.number().int().positive() });

export const RuntimeMessageSchema = z.discriminatedUnion('type', [
  ExecuteMessageSchema,
  DiscoveryStartSchema,
  DiscoveryStopSchema,
  SyncMessageSchema,
  PingMessageSchema,
]);
export type RuntimeMessage = z.infer<typeof RuntimeMessageSchema>;
export type ExecuteMessage = z.infer<typeof ExecuteMessageSchema>;

/** Full set of frames the runtime can send (challenge is transport-level). */
export const RuntimeFrameSchema = z.discriminatedUnion('type', [
  ChallengeMessageSchema,
  ExecuteMessageSchema,
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
});
export type ExecuteRequest = z.infer<typeof ExecuteRequestSchema>;

export const DomainInputSchema = z.object({
  domain: z.string().min(1).max(253),
  deepCapture: z.boolean().default(false),
  csrf: z
    .object({
      bootstrapPath: z.string().min(1).max(512).startsWith('/'),
      tokenField: z.string().min(1).max(64),
      header: z.string().min(1).max(64).regex(/^[A-Za-z0-9-]+$/),
    })
    .optional(),
});

export const ToolPatchSchema = z.object({
  name: z.string().min(1).max(60).regex(/^[a-z0-9_]+$/).optional(),
  description: z.string().min(1).max(600).optional(),
});

// ---------------------------------------------------------------------------
// Stored records
// ---------------------------------------------------------------------------

export const PermissionLevelSchema = z.enum(['READ', 'WRITE', 'DESTRUCTIVE']);
export const ToolStatusSchema = z.enum(['draft', 'approved', 'revoked']);

export interface DomainRecord {
  domain: string;
  /** Exact scheme://host[:port] this domain's tools may call. */
  origin: string;
  enabled: boolean;
  deepCapture: boolean;
  enabledAt: string | null;
  csrf?: { bootstrapPath: string; tokenField: string; header: string };
  requestCount: number;
  lastSeenAt: string | null;
}

export interface DiscoveredEndpointRecord {
  key: string;
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
  sources: string[];
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
  method: string;
  pathTemplate: string;
  paramLocations: Record<string, 'path' | 'query' | 'body'>;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  permission: 'READ' | 'WRITE' | 'DESTRUCTIVE';
  status: 'draft' | 'approved' | 'revoked';
  reviewRequired: boolean;
  tags: string[];
  endpointKey: string;
  discovery: {
    sampleCount: number;
    sources: string[];
    firstSeenAt: string;
    statusCodes: number[];
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
  toolId: string;
  toolName: string;
  domain: string;
  method: string;
  path: string;
  actor: 'utcp' | 'dashboard' | 'cli';
  outcome: 'ok' | 'error' | 'rejected' | 'timeout' | 'disconnected';
  httpStatus: number | null;
  latencyMs: number | null;
  startedAt: string;
  finishedAt: string | null;
  requestBytes: number | null;
  responseBytes: number | null;
  truncated: boolean;
  errorCode: string | null;
  errorMessage: string | null;
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
  domain: string | null;
  toolName: string | null;
  message: string;
  detail?: Record<string, unknown>;
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
// Result envelope returned to a UTCP client
// ---------------------------------------------------------------------------

export interface ExecutionEnvelope {
  ok: boolean;
  tool: string;
  domain: string;
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
  error?: { code: string; message: string; hint?: string };
}
