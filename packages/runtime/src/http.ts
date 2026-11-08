/**
 * HTTP surface of the runtime.
 *
 * Three audiences share one loopback port:
 *   - the dashboard (bearer token from the bootstrap URL),
 *   - the extension (only /api/v1/pair/claim, gated by a one-time code),
 *   - the UTCP provider / CLI (bearer token).
 *
 * The extension's websocket is the only channel that can execute a request
 * against a website; no HTTP route proxies arbitrary URLs. Websites are
 * addressed by their origin, never by hostname, so two applications on the same
 * host stay isolated.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  DomainInputSchema,
  ErrorCode,
  ExecuteRequestSchema,
  PairClaimSchema,
  ToolPatchSchema,
  normalizeDomain,
  parseDomainInput,
  toErrorShape,
  type DomainRecord,
  type ExecutionEnvelope,
} from '@utcp-browser-session/shared';
import type { RuntimeConfig } from './config.ts';
import type { Store } from './store.ts';
import type { ExtensionHub } from './connections.ts';
import type { Executor } from './executor.ts';
import type { Logger } from './logger.ts';
import { discoverWorkflows } from './workflows.ts';
import { buildManual, validateManualDocument, TOKEN_VARIABLE } from './manual.ts';
import { safeEqual } from './token.ts';

const MAX_BODY_BYTES = 1024 * 1024;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export interface RuntimeServerOptions {
  config: RuntimeConfig;
  store: Store;
  hub: ExtensionHub;
  executor: Executor;
  logger: Logger;
  /** Admin credential. */
  token: string;
  /** Execute-only credential handed to UTCP clients. */
  agentToken: string;
}

/** Routes an execute-only credential may call. Everything else needs admin. */
const AGENT_ROUTES: Array<{ method: string; test: RegExp }> = [
  { method: 'POST', test: /^\/api\/v1\/execute$/ },
  { method: 'GET', test: /^\/api\/v1\/status$/ },
  { method: 'GET', test: /^\/api\/v1\/manual$/ },
  { method: 'GET', test: /^\/api\/v1\/manual\/validate$/ },
];

function isAgentRoute(method: string, pathname: string): boolean {
  return AGENT_ROUTES.some((route) => route.method === method && route.test.test(pathname));
}

export interface RuntimeServer {
  readonly server: http.Server;
  start(): Promise<{ port: number; url: string }>;
  stop(): Promise<void>;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new HttpError(413, ErrorCode.MESSAGE_TOO_LARGE, 'Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, ErrorCode.INVALID_REQUEST, 'Body must be valid JSON.'));
      }
    });
    req.on('error', (error) => reject(error));
  });
}

function extensionOrigin(req: http.IncomingMessage): string | null {
  const origin = req.headers.origin;
  if (!origin) return null;
  return /^chrome-extension:\/\/[a-p]{32}$/.test(origin) ? origin : null;
}

export function createRuntimeServer(options: RuntimeServerOptions): RuntimeServer {
  const { config, store, hub, executor, logger, token, agentToken } = options;

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((error) => {
      if (res.headersSent) return;
      if (error instanceof HttpError) {
        json(res, error.status, { error: error.code, message: error.message });
        return;
      }
      const shape = toErrorShape(error);
      logger.error('http.unhandled', shape);
      json(res, 500, { error: shape.code, message: shape.message });
    });
  });

  server.on('upgrade', (request, socket, head) => {
    if (!hub.handleUpgrade(request, socket, head)) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
    }
  });

  /** Which credential the request presented. */
  function scopesOf(req: http.IncomingMessage): { admin: boolean; agent: boolean } {
    const header = req.headers.authorization ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return { admin: false, agent: false };
    const presented = match[1].trim();
    return { admin: safeEqual(presented, token), agent: safeEqual(presented, agentToken) };
  }

  /** Accept either a full origin (preferred) or a bare hostname. */
  function resolveDomain(value: string): DomainRecord | undefined {
    let decoded = value;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      /* keep the raw value */
    }
    if (decoded.startsWith('http://') || decoded.startsWith('https://')) return store.getDomain(decoded);
    return store.getDomainByHostname(normalizeDomain(decoded));
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', config.publicUrl);
    const pathname = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();

    // --- unauthenticated, side-effect free ---------------------------------
    if (pathname === '/health') {
      json(res, 200, { ok: true, service: 'utcp-browser-session', version: '0.2.0' });
      return;
    }

    if (pathname === '/api/v1/pair/claim') {
      const origin = extensionOrigin(req);
      const corsHeaders: Record<string, string> = origin
        ? {
            'access-control-allow-origin': origin,
            'access-control-allow-methods': 'POST, OPTIONS',
            'access-control-allow-headers': 'content-type',
            'access-control-max-age': '600',
            vary: 'origin',
          }
        : {};
      if (method === 'OPTIONS') {
        res.writeHead(204, corsHeaders);
        res.end();
        return;
      }
      if (method !== 'POST') throw new HttpError(405, ErrorCode.INVALID_REQUEST, 'POST required.');
      if (!origin) {
        store.audit({
          kind: 'pair.claim_rejected',
          severity: 'warn',
          actor: 'extension',
          message: 'Pairing claim rejected: request did not come from a Chrome extension.',
        });
        throw new HttpError(403, ErrorCode.ORIGIN_NOT_ALLOWED, 'Pairing claims must come from a Chrome extension origin.');
      }
      const parsed = PairClaimSchema.safeParse(await readJson(req));
      if (!parsed.success) throw new HttpError(400, ErrorCode.INVALID_REQUEST, 'Invalid pairing claim payload.');
      const extensionIdFromOrigin = origin.replace('chrome-extension://', '');
      if (parsed.data.extensionId !== extensionIdFromOrigin) {
        throw new HttpError(403, ErrorCode.ORIGIN_NOT_ALLOWED, 'extensionId does not match the request origin.');
      }
      const verdict = store.consumePairingCode(parsed.data.code);
      if (!verdict.ok) {
        store.audit({
          kind: 'pair.claim_rejected',
          severity: 'warn',
          actor: 'extension',
          message: `Pairing claim rejected: ${verdict.reason}`,
        });
        throw new HttpError(400, ErrorCode.PAIRING_INVALID, verdict.reason ?? 'Invalid pairing code.');
      }
      const client = store.createClient({
        extensionId: parsed.data.extensionId,
        label: parsed.data.label ?? 'Chrome extension',
        publicKeyJwk: parsed.data.publicKeyJwk,
      });
      store.audit({
        kind: 'pair.claimed',
        severity: 'info',
        actor: 'extension',
        message: `Extension paired as "${client.label}" (${client.clientId}).`,
      });
      json(res, 201, { clientId: client.clientId, runtimeId: store.runtimeId }, corsHeaders);
      return;
    }

    // --- everything else needs a credential --------------------------------
    if (pathname.startsWith('/api/')) {
      const scopes = scopesOf(req);
      if (!scopes.admin && !scopes.agent) {
        json(res, 401, { error: ErrorCode.AUTH_REQUIRED, message: 'A runtime bearer token is required.' });
        return;
      }
      // The agent credential can run tools and read the manual, nothing else:
      // no approvals, no domain changes, no policy, no pairing codes.
      if (!scopes.admin && !isAgentRoute(method, pathname)) {
        json(res, 403, {
          error: ErrorCode.POLICY_BLOCKED,
          message: 'This credential is limited to executing approved tools; an admin credential is required.',
        });
        return;
      }
    }

    if (pathname === '/api/v1/status') {
      json(res, 200, {
        ok: true,
        runtimeId: store.runtimeId,
        version: '0.2.0',
        connection: hub.status(),
        stats: store.stats(),
        settings: store.settings,
        tokenVariable: TOKEN_VARIABLE,
      });
      return;
    }

    if (pathname === '/api/v1/metrics' && method === 'GET') {
      json(res, 200, {
        ...hub.metrics(),
        store: store.stats(),
        memory: process.memoryUsage().rss,
        uptimeSeconds: Math.round(process.uptime()),
      });
      return;
    }

    if (pathname === '/api/v1/settings' && method === 'POST') {
      const parsed = z
        .object({
          manualName: z.string().min(1).max(60).optional(),
          defaultTimeoutMs: z.number().int().min(1000).max(120_000).optional(),
          maxResponseBytes: z.number().int().min(1024).max(8 * 1024 * 1024).optional(),
          rateLimitPerMinute: z.number().int().min(1).max(600).optional(),
          maxInFlight: z.number().int().min(1).max(32).optional(),
          maxQueue: z.number().int().min(0).max(200).optional(),
        })
        .safeParse(await readJson(req));
      if (!parsed.success) throw new HttpError(400, ErrorCode.INVALID_REQUEST, 'Invalid settings payload.');
      json(res, 200, { settings: store.updateSettings(parsed.data) });
      return;
    }

    // --- pairing code ------------------------------------------------------
    if (pathname === '/api/v1/pair/start' && method === 'POST') {
      const pairing = store.createPairingCode(5 * 60_000);
      store.audit({
        kind: 'pair.code_created',
        severity: 'info',
        actor: 'dashboard',
        message: 'A pairing code was created.',
      });
      json(res, 201, { code: pairing.code, expiresAt: pairing.expiresAt });
      return;
    }

    // --- domains -----------------------------------------------------------
    if (pathname === '/api/v1/domains' && method === 'GET') {
      json(res, 200, {
        domains: store.listDomains().map((domain) => ({
          ...domain,
          endpoints: store.listEndpoints(domain.origin).length,
          approvedTools: store.listTools({ origin: domain.origin, status: 'approved' }).length,
        })),
      });
      return;
    }

    if (pathname === '/api/v1/domains' && method === 'POST') {
      const parsed = DomainInputSchema.safeParse(await readJson(req));
      if (!parsed.success) throw new HttpError(400, ErrorCode.INVALID_REQUEST, 'Invalid domain payload.');
      const target = parseDomainInput(parsed.data.domain);
      if (!target) throw new HttpError(400, ErrorCode.DOMAIN_NOT_ALLOWED, 'Enter a valid hostname or site URL.');
      const record = store.enableDomain(target.origin, target.domain, {
        deepCapture: parsed.data.deepCapture,
        captureEnums: parsed.data.captureEnums,
        csrf: parsed.data.csrf,
        policy: parsed.data.policy,
      });
      store.audit({
        kind: 'domain.enabled',
        severity: 'info',
        actor: 'dashboard',
        origin: target.origin,
        message: `Enabled ${target.origin}${record.deepCapture ? ' with schema capture' : ''}.`,
      });
      hub.sync();
      json(res, 201, { domain: record });
      return;
    }

    const domainMatch = /^\/api\/v1\/domains\/([^/]+?)(\/discovery)?$/.exec(pathname);
    if (domainMatch) {
      const record = resolveDomain(domainMatch[1]);
      if (!record) throw new HttpError(404, ErrorCode.DOMAIN_NOT_ALLOWED, 'Domain is not enabled.');
      const origin = record.origin;
      const isDiscovery = !!domainMatch[2];

      if (method === 'PATCH' && !isDiscovery) {
        const parsed = z
          .object({
            policy: z
              .object({
                maxPermission: z.enum(['READ', 'WRITE', 'DESTRUCTIVE']).optional(),
                confirmWrites: z.boolean().optional(),
                blockedPathPrefixes: z.array(z.string().max(200)).max(20).optional(),
              })
              .optional(),
            deepCapture: z.boolean().optional(),
            captureEnums: z.boolean().optional(),
          })
          .safeParse(await readJson(req));
        if (!parsed.success) throw new HttpError(400, ErrorCode.INVALID_REQUEST, 'Invalid domain patch.');
        if (parsed.data.policy) store.updatePolicy(origin, parsed.data.policy);
        if (parsed.data.deepCapture !== undefined || parsed.data.captureEnums !== undefined) {
          store.enableDomain(origin, record.domain, {
            deepCapture: parsed.data.deepCapture ?? record.deepCapture,
            captureEnums: parsed.data.captureEnums ?? record.captureEnums,
          });
        }
        store.audit({
          kind: 'domain.policy_updated',
          severity: 'warn',
          actor: 'dashboard',
          origin,
          message: `Policy updated for ${origin}.`,
          detail: { policy: parsed.data.policy, deepCapture: parsed.data.deepCapture, captureEnums: parsed.data.captureEnums },
        });
        hub.sync();
        json(res, 200, { domain: store.getDomain(origin) });
        return;
      }

      if (method === 'DELETE' && !isDiscovery) {
        if (!store.disableDomain(origin)) throw new HttpError(404, ErrorCode.DOMAIN_NOT_ALLOWED, 'Domain is not enabled.');
        store.audit({
          kind: 'domain.disabled',
          severity: 'warn',
          actor: 'dashboard',
          origin,
          message: `Disabled ${origin} and revoked its tools.`,
        });
        hub.sync();
        json(res, 200, { ok: true });
        return;
      }
      if (isDiscovery && method === 'POST') {
        if (!record.enabled) throw new HttpError(404, ErrorCode.DOMAIN_NOT_ALLOWED, 'Enable the domain first.');
        try {
          hub.startDiscovery(origin, record.domain, record.deepCapture, record.captureEnums);
        } catch (error) {
          throw new HttpError(409, ErrorCode.NO_BROWSER, (error as Error).message);
        }
        store.audit({
          kind: 'discovery.started',
          severity: 'info',
          actor: 'dashboard',
          origin,
          message: `Discovery started for ${origin}.`,
        });
        json(res, 200, { ok: true, origin, deepCapture: record.deepCapture, captureEnums: record.captureEnums });
        return;
      }
      if (isDiscovery && method === 'DELETE') {
        hub.stopDiscovery(origin);
        store.audit({
          kind: 'discovery.stopped',
          severity: 'info',
          actor: 'dashboard',
          origin,
          message: `Discovery stopped for ${origin}.`,
        });
        json(res, 200, { ok: true });
        return;
      }
    }

    // --- endpoints ---------------------------------------------------------
    if (pathname === '/api/v1/endpoints' && method === 'GET') {
      const raw = url.searchParams.get('origin') ?? url.searchParams.get('domain');
      const record = raw ? resolveDomain(raw) : undefined;
      json(res, 200, { endpoints: store.listEndpoints(record?.origin) });
      return;
    }

    // --- tools -------------------------------------------------------------
    if (pathname === '/api/v1/tools' && method === 'GET') {
      const status = url.searchParams.get('status');
      const raw = url.searchParams.get('origin') ?? url.searchParams.get('domain');
      const record = raw ? resolveDomain(raw) : undefined;
      const tools = store.listTools({
        status: status === 'draft' || status === 'approved' || status === 'revoked' ? status : undefined,
        origin: record?.origin,
      });
      json(res, 200, { tools });
      return;
    }

    if (pathname === '/api/v1/tools/generate' && method === 'POST') {
      const parsed = z
        .object({
          origin: z.string().min(1).optional(),
          domain: z.string().min(1).optional(),
          endpointKeys: z.array(z.string()).max(200).optional(),
        })
        .safeParse(await readJson(req));
      if (!parsed.success) throw new HttpError(400, ErrorCode.INVALID_REQUEST, 'Invalid generate payload.');
      const raw = parsed.data.origin ?? parsed.data.domain;
      if (!raw) throw new HttpError(400, ErrorCode.INVALID_REQUEST, 'origin is required.');
      const record = resolveDomain(raw);
      if (!record || !record.enabled) throw new HttpError(404, ErrorCode.DOMAIN_NOT_ALLOWED, 'Domain is not enabled.');
      const result = store.generateDrafts(record.origin, parsed.data.endpointKeys);
      store.audit({
        kind: 'tools.generated',
        severity: 'info',
        actor: 'dashboard',
        origin: record.origin,
        message: `Generated ${result.created.length} draft tool(s) for ${record.origin}.`,
        detail: { skipped: result.skipped.length },
      });
      json(res, 201, result);
      return;
    }

    const toolActionMatch = /^\/api\/v1\/tools\/([^/]+)(?:\/(approve|revoke))?$/.exec(pathname);
    if (toolActionMatch) {
      const id = decodeURIComponent(toolActionMatch[1]);
      const action = toolActionMatch[2];
      if (method === 'POST' && action === 'approve') {
        const tool = store.getTool(id);
        if (!tool) throw new HttpError(404, ErrorCode.UNKNOWN_TOOL, 'Tool not found.');
        const approved = store.approveTool(id, 'dashboard');
        if (!approved) throw new HttpError(409, ErrorCode.DOMAIN_NOT_ALLOWED, "Enable the tool's domain before approving it.");
        store.audit({
          kind: 'tool.approved',
          severity: 'info',
          actor: 'dashboard',
          origin: approved.origin,
          toolName: approved.fqName,
          message: `Approved "${approved.fqName}" (${approved.permission}).`,
        });
        json(res, 200, { tool: approved });
        return;
      }
      if (method === 'POST' && action === 'revoke') {
        const revoked = store.revokeTool(id, 'dashboard');
        if (!revoked) throw new HttpError(404, ErrorCode.UNKNOWN_TOOL, 'Tool not found.');
        store.audit({
          kind: 'tool.revoked',
          severity: 'warn',
          actor: 'dashboard',
          origin: revoked.origin,
          toolName: revoked.fqName,
          message: `Revoked "${revoked.fqName}".`,
        });
        json(res, 200, { tool: revoked });
        return;
      }
      if (method === 'PATCH' && !action) {
        const parsed = ToolPatchSchema.safeParse(await readJson(req));
        if (!parsed.success) throw new HttpError(400, ErrorCode.INVALID_REQUEST, 'Invalid tool patch.');
        const updated = store.updateTool(id, parsed.data);
        if (!updated) throw new HttpError(409, ErrorCode.INVALID_REQUEST, 'Tool not found or the new name is taken.');
        store.audit({
          kind: 'tool.updated',
          severity: 'info',
          actor: 'dashboard',
          origin: updated.origin,
          toolName: updated.fqName,
          message: `Updated "${updated.fqName}".`,
          detail: { permission: updated.permission },
        });
        json(res, 200, { tool: updated });
        return;
      }
      if (method === 'DELETE' && !action) {
        if (!store.deleteTool(id)) throw new HttpError(404, ErrorCode.UNKNOWN_TOOL, 'Tool not found.');
        json(res, 200, { ok: true });
        return;
      }
    }

    // --- execution ---------------------------------------------------------
    if (pathname === '/api/v1/execute' && method === 'POST') {
      const parsed = ExecuteRequestSchema.safeParse(await readJson(req));
      if (!parsed.success) throw new HttpError(400, ErrorCode.INVALID_REQUEST, 'Invalid execute payload.');
      const correlationId =
        parsed.data.correlationId ?? (req.headers['x-correlation-id'] as string | undefined) ?? undefined;

      // If the caller hangs up, stop the browser request instead of letting it
      // finish into a response nobody will read.
      let dispatchId: string | null = null;
      const onClose = (): void => {
        if (!res.writableEnded && dispatchId) hub.cancel(dispatchId, 'client_cancelled');
      };
      // `res` closes when the caller aborts; `req` may already be complete.
      res.on('close', onClose);

      const envelope: ExecutionEnvelope = await executor.execute(
        { ...parsed.data, correlationId },
        { onDispatched: (id) => { dispatchId = id; } },
      );
      res.off('close', onClose);
      json(res, 200, envelope, { 'x-correlation-id': envelope.correlationId });
      return;
    }

    if (pathname === '/api/v1/executions' && method === 'GET') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200);
      const toolId = url.searchParams.get('toolId') ?? undefined;
      json(res, 200, { executions: store.listExecutions(limit, toolId) });
      return;
    }

    if (pathname === '/api/v1/audit' && method === 'GET') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 100) || 100, 500);
      const kind = url.searchParams.get('kind') ?? undefined;
      json(res, 200, { events: store.listAudit(limit, kind) });
      return;
    }

    if (pathname === '/api/v1/audit/verify' && method === 'GET') {
      json(res, 200, store.verifyAudit());
      return;
    }

    // --- workflows ---------------------------------------------------------
    if (pathname === '/api/v1/workflows' && method === 'GET') {
      const status = url.searchParams.get('status');
      json(res, 200, {
        workflows: store.listWorkflows(
          status === 'draft' || status === 'approved' || status === 'rejected' ? status : undefined,
        ),
      });
      return;
    }

    if (pathname === '/api/v1/workflows/discover' && method === 'POST') {
      const proposals = discoverWorkflows(store);
      store.saveWorkflows(proposals);
      store.audit({
        kind: 'workflows.discovered',
        severity: 'info',
        actor: 'dashboard',
        message: `Workflow discovery produced ${proposals.length} proposal(s); nothing was published.`,
      });
      json(res, 200, { proposals, total: store.listWorkflows().length });
      return;
    }

    const workflowMatch = /^\/api\/v1\/workflows\/([^/]+)\/(approve|reject)$/.exec(pathname);
    if (workflowMatch && method === 'POST') {
      const updated = store.setWorkflowStatus(
        decodeURIComponent(workflowMatch[1]),
        workflowMatch[2] === 'approve' ? 'approved' : 'rejected',
      );
      if (!updated) throw new HttpError(404, ErrorCode.INVALID_REQUEST, 'Workflow not found.');
      store.audit({
        kind: workflowMatch[2] === 'approve' ? 'workflow.approved' : 'workflow.rejected',
        severity: 'info',
        actor: 'dashboard',
        origin: updated.origin,
        message: `Workflow "${updated.name}" ${workflowMatch[2] === 'approve' ? 'approved' : 'rejected'}.`,
      });
      json(res, 200, { workflow: updated });
      return;
    }

    // --- manual ------------------------------------------------------------
    if (pathname === '/api/v1/manual' && method === 'GET') {
      const manualName = url.searchParams.get('manual') ?? store.settings.manualName;
      const manual = buildManual(store, { manualName, runtimeUrl: config.publicUrl });
      // Validate before serving: a manual that fails its own policy (namespacing,
      // call-template integrity, credential material) must not reach a client.
      const report = validateManualDocument(manual, store.settings.manualName);
      if (!report.ok) {
        logger.error('manual.invalid', { errors: report.errors.slice(0, 5) });
        json(res, 500, { error: ErrorCode.INTERNAL_ERROR, message: 'The generated manual failed validation.', details: report.errors });
        return;
      }
      json(res, 200, manual);
      return;
    }

    if (pathname === '/api/v1/manual/validate' && method === 'GET') {
      const manual = buildManual(store, { manualName: store.settings.manualName, runtimeUrl: config.publicUrl });
      const report = validateManualDocument(manual, store.settings.manualName);
      json(res, report.ok ? 200 : 422, report);
      return;
    }

    // --- clients -----------------------------------------------------------
    if (pathname === '/api/v1/clients' && method === 'GET') {
      json(res, 200, {
        clients: store.listClients().map((client) => ({
          clientId: client.clientId,
          label: client.label,
          extensionId: client.extensionId,
          createdAt: client.createdAt,
          lastSeenAt: client.lastSeenAt,
          revoked: !!client.revokedAt,
        })),
      });
      return;
    }

    const clientMatch = /^\/api\/v1\/clients\/([^/]+)$/.exec(pathname);
    if (clientMatch && method === 'DELETE') {
      const clientId = decodeURIComponent(clientMatch[1]);
      const revoked = store.revokeClient(clientId);
      if (!revoked) throw new HttpError(404, ErrorCode.PAIRING_INVALID, 'Unknown client.');
      // Revocation must take effect now, not at the next reconnect.
      hub.disconnectClient(clientId);
      store.audit({
        kind: 'extension.revoked',
        severity: 'warn',
        actor: 'dashboard',
        message: 'A paired browser was revoked.',
      });
      json(res, 200, { ok: true });
      return;
    }

    if (pathname.startsWith('/api/')) {
      json(res, 404, { error: ErrorCode.INVALID_REQUEST, message: `No route for ${method} ${pathname}` });
      return;
    }

    // --- static dashboard --------------------------------------------------
    if (method === 'GET' || method === 'HEAD') {
      serveStatic(req, res, pathname, config.dashboardDir);
      return;
    }

    json(res, 405, { error: ErrorCode.INVALID_REQUEST, message: 'Method not allowed.' });
  }

  return {
    server,
    async start() {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => resolve());
      });
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : config.port;
      const url = `http://${config.host}:${port}`;
      return { port, url };
    },
    async stop() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, root: string): void {
  const fallback = `<!doctype html><html><head><meta charset="utf-8"><title>UTCP Browser Session</title>
<style>body{background:#0b1020;color:#e6edf7;font:15px/1.6 ui-sans-serif,system-ui;display:grid;place-items:center;height:100vh;margin:0}
code{background:#141b2d;padding:2px 6px;border-radius:4px}</style></head>
<body><div><h1>Dashboard not built</h1>
<p>The runtime is running, but <code>dashboard/dist</code> was not found.</p>
<p>Run <code>npm run build</code> in the repository root, then reload this page.</p></div></body></html>`;

  if (!fs.existsSync(root)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fallback);
    return;
  }

  const relative = pathname === '/' ? '/index.html' : pathname;
  const base = path.resolve(root);
  const resolved = path.resolve(root, `.${relative}`);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }

  const target = fs.existsSync(resolved) && fs.statSync(resolved).isFile() ? resolved : path.join(root, 'index.html');
  if (!fs.existsSync(target)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fallback);
    return;
  }
  const ext = path.extname(target).toLowerCase();
  const type = MIME[ext] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=3600' });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(target).pipe(res);
}
