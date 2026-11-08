/**
 * HTTP surface of the runtime.
 *
 * Three audiences share one loopback port:
 *   - the dashboard (bearer token from the bootstrap URL),
 *   - the extension (only /api/v1/pair/claim, gated by a one-time code),
 *   - the UTCP provider / CLI (bearer token).
 *
 * The extension's websocket is the only channel that can execute a request
 * against a website; no HTTP route proxies arbitrary URLs.
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
  normalizeDomain,
  parseDomainInput,
  toErrorShape,
  type ExecutionEnvelope,
} from '@utcp-browser-session/shared';
import type { RuntimeConfig } from './config.ts';
import type { Store } from './store.ts';
import type { ExtensionHub } from './connections.ts';
import type { Executor } from './executor.ts';
import type { Logger } from './logger.ts';
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
  token: string;
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
  const { config, store, hub, executor, logger, token } = options;

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

  function authorized(req: http.IncomingMessage): boolean {
    const header = req.headers.authorization ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return false;
    return safeEqual(match[1].trim(), token);
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', config.publicUrl);
    const pathname = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();

    // --- unauthenticated, side-effect free ---------------------------------
    if (pathname === '/health') {
      json(res, 200, { ok: true, service: 'utcp-browser-session', version: '0.1.0' });
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
          domain: null,
          toolName: null,
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
          domain: null,
          toolName: null,
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
        domain: null,
        toolName: null,
        message: `Extension paired as "${client.label}" (${client.clientId}).`,
      });
      json(res, 201, { clientId: client.clientId, runtimeId: store.runtimeId }, corsHeaders);
      return;
    }

    // --- everything else needs the runtime token ---------------------------
    if (pathname.startsWith('/api/') && !authorized(req)) {
      json(res, 401, { error: ErrorCode.AUTH_REQUIRED, message: 'A runtime bearer token is required.' });
      return;
    }

    if (pathname === '/api/v1/status') {
      json(res, 200, {
        ok: true,
        runtimeId: store.runtimeId,
        version: '0.1.0',
        connection: hub.status(),
        stats: store.stats(),
        settings: store.settings,
        tokenVariable: TOKEN_VARIABLE,
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
        domain: null,
        toolName: null,
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
          endpoints: store.listEndpoints(domain.domain).length,
          approvedTools: store.listTools({ domain: domain.domain, status: 'approved' }).length,
        })),
      });
      return;
    }

    if (pathname === '/api/v1/domains' && method === 'POST') {
      const parsed = DomainInputSchema.safeParse(await readJson(req));
      if (!parsed.success) throw new HttpError(400, ErrorCode.INVALID_REQUEST, 'Invalid domain payload.');
      const target = parseDomainInput(parsed.data.domain);
      if (!target) throw new HttpError(400, ErrorCode.DOMAIN_NOT_ALLOWED, 'Enter a valid hostname or site URL.');
      const domain = target.domain;
      const record = store.enableDomain(domain, {
        origin: target.origin,
        deepCapture: parsed.data.deepCapture,
        csrf: parsed.data.csrf,
      });
      store.audit({
        kind: 'domain.enabled',
        severity: 'info',
        actor: 'dashboard',
        domain,
        toolName: null,
        message: `Domain ${domain} enabled${record.deepCapture ? ' with schema capture' : ''}.`,
      });
      hub.sync();
      json(res, 201, { domain: record });
      return;
    }

    const domainMatch = /^\/api\/v1\/domains\/([^/]+)(\/discovery)?$/.exec(pathname);
    if (domainMatch) {
      const domain = normalizeDomain(decodeURIComponent(domainMatch[1]));
      const isDiscovery = !!domainMatch[2];
      if (method === 'DELETE' && !isDiscovery) {
        const removed = store.disableDomain(domain);
        if (!removed) throw new HttpError(404, ErrorCode.DOMAIN_NOT_ALLOWED, 'Domain is not enabled.');
        store.audit({
          kind: 'domain.disabled',
          severity: 'warn',
          actor: 'dashboard',
          domain,
          toolName: null,
          message: `Domain ${domain} disabled and its tools revoked.`,
        });
        hub.sync();
        json(res, 200, { ok: true });
        return;
      }
      if (isDiscovery && method === 'POST') {
        if (!store.isDomainEnabled(domain)) throw new HttpError(404, ErrorCode.DOMAIN_NOT_ALLOWED, 'Enable the domain first.');
        const record = store.getDomain(domain);
        try {
          hub.startDiscovery(domain, record?.deepCapture ?? false);
        } catch (error) {
          throw new HttpError(409, ErrorCode.EXTENSION_DISCONNECTED, (error as Error).message);
        }
        store.audit({
          kind: 'discovery.started',
          severity: 'info',
          actor: 'dashboard',
          domain,
          toolName: null,
          message: `Discovery started for ${domain}.`,
        });
        json(res, 200, { ok: true, domain, deepCapture: record?.deepCapture ?? false });
        return;
      }
      if (isDiscovery && method === 'DELETE') {
        hub.stopDiscovery(domain);
        store.audit({
          kind: 'discovery.stopped',
          severity: 'info',
          actor: 'dashboard',
          domain,
          toolName: null,
          message: `Discovery stopped for ${domain}.`,
        });
        json(res, 200, { ok: true });
        return;
      }
    }

    // --- endpoints ---------------------------------------------------------
    if (pathname === '/api/v1/endpoints' && method === 'GET') {
      const domain = url.searchParams.get('domain');
      json(res, 200, { endpoints: store.listEndpoints(domain ? normalizeDomain(domain) : undefined) });
      return;
    }

    // --- tools -------------------------------------------------------------
    if (pathname === '/api/v1/tools' && method === 'GET') {
      const status = url.searchParams.get('status');
      const domain = url.searchParams.get('domain');
      const tools = store.listTools({
        status: status === 'draft' || status === 'approved' || status === 'revoked' ? status : undefined,
        domain: domain ? normalizeDomain(domain) : undefined,
      });
      json(res, 200, { tools });
      return;
    }

    if (pathname === '/api/v1/tools/generate' && method === 'POST') {
      const parsed = z
        .object({ domain: z.string().min(1), endpointKeys: z.array(z.string()).max(200).optional() })
        .safeParse(await readJson(req));
      if (!parsed.success) throw new HttpError(400, ErrorCode.INVALID_REQUEST, 'Invalid generate payload.');
      const domain = normalizeDomain(parsed.data.domain);
      if (!store.isDomainEnabled(domain)) throw new HttpError(404, ErrorCode.DOMAIN_NOT_ALLOWED, 'Domain is not enabled.');
      const result = store.generateDrafts(domain, parsed.data.endpointKeys);
      store.audit({
        kind: 'tools.generated',
        severity: 'info',
        actor: 'dashboard',
        domain,
        toolName: null,
        message: `Generated ${result.created.length} draft tool(s) for ${domain}.`,
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
        if (!approved) throw new HttpError(409, ErrorCode.DOMAIN_NOT_ALLOWED, 'Enable the tool\'s domain before approving it.');
        store.audit({
          kind: 'tool.approved',
          severity: 'info',
          actor: 'dashboard',
          domain: approved.domain,
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
          domain: revoked.domain,
          toolName: revoked.fqName,
          message: `Revoked "${revoked.fqName}".`,
        });
        json(res, 200, { tool: revoked });
        return;
      }
      if (method === 'PATCH' && !action) {
        const parsed = z.object({ name: z.string().min(1).max(60).optional(), description: z.string().min(1).max(600).optional() }).safeParse(await readJson(req));
        if (!parsed.success) throw new HttpError(400, ErrorCode.INVALID_REQUEST, 'Invalid tool patch.');
        const updated = store.updateTool(id, parsed.data);
        if (!updated) throw new HttpError(409, ErrorCode.INVALID_REQUEST, 'Tool not found or the new name is taken.');
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
      const envelope: ExecutionEnvelope = await executor.execute(parsed.data);
      json(res, 200, envelope);
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

    // --- manual ------------------------------------------------------------
    if (pathname === '/api/v1/manual' && method === 'GET') {
      const manualName = url.searchParams.get('manual') ?? store.settings.manualName;
      const manual = buildManual(store, { manualName, runtimeUrl: config.publicUrl });
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
      const revoked = store.revokeClient(decodeURIComponent(clientMatch[1]));
      if (!revoked) throw new HttpError(404, ErrorCode.PAIRING_INVALID, 'Unknown client.');
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
  const resolved = path.resolve(root, `.${relative}`);
  if (!resolved.startsWith(path.resolve(root))) {
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
