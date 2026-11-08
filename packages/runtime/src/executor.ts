/**
 * Execution pipeline.
 *
 * Every invocation walks the same path, in this order:
 *   resolve tool -> approval -> domain allowlist -> argument validation ->
 *   destructive confirmation -> rate limit -> URL construction -> URL policy ->
 *   size limits -> browser dispatch -> response normalization -> audit.
 *
 * There is no branch that falls back to a direct HTTP request: if the browser
 * cannot perform the call, the call fails.
 */
import {
  ErrorCode,
  ToolError,
  checkRedirect,
  checkTargetUrl,
  buildRequest,
  classifyPermission,
  isLoopbackDomain,
  jsonByteLength,
  LIMITS,
  pickSafeHeaders,
  redactString,
  toErrorShape,
  validateArguments,
  type ExecuteRequest,
  type ExecutionEnvelope,
  type ExecuteMessage,
  type ResultMessage,
  type ToolRecord,
} from '@utcp-browser-session/shared';
import type { ExtensionHub } from './connections.ts';
import type { Logger } from './logger.ts';
import type { Store } from './store.ts';
import { generateId } from './token.ts';

class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  take(key: string, limitPerMinute: number): boolean {
    const now = Date.now();
    const windowStart = now - 60_000;
    const existing = (this.hits.get(key) ?? []).filter((ts) => ts > windowStart);
    if (existing.length >= limitPerMinute) {
      this.hits.set(key, existing);
      return false;
    }
    existing.push(now);
    this.hits.set(key, existing);
    return true;
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class Executor {
  private readonly limiter = new SlidingWindowLimiter();
  private readonly store: Store;
  private readonly hub: ExtensionHub;
  private readonly logger: Logger;

  constructor(store: Store, hub: ExtensionHub, logger: Logger) {
    this.store = store;
    this.hub = hub;
    this.logger = logger;
  }

  async execute(request: ExecuteRequest): Promise<ExecutionEnvelope> {
    const startedAt = new Date();
    const executionId = generateId('exec');
    let tool: ToolRecord | undefined;

    const record = {
      id: executionId,
      toolId: '',
      toolName: request.tool,
      domain: '',
      method: '',
      path: '',
      actor: request.actor,
      outcome: 'rejected' as 'ok' | 'error' | 'rejected' | 'timeout' | 'disconnected',
      httpStatus: null as number | null,
      latencyMs: null as number | null,
      startedAt: startedAt.toISOString(),
      finishedAt: null as string | null,
      requestBytes: null as number | null,
      responseBytes: null as number | null,
      truncated: false,
      errorCode: null as string | null,
      errorMessage: null as string | null,
      responsePreview: null as string | null,
    };

    try {
      tool = this.store.getToolByFqName(request.tool) ?? this.store.getTool(request.tool);
      if (!tool) {
        throw new ToolError(ErrorCode.UNKNOWN_TOOL, `No tool named "${request.tool}" is registered.`, {
          hint: 'Register the manual first, or check the tool name in the dashboard.',
        });
      }
      record.toolId = tool.id;
      record.toolName = tool.fqName;
      record.domain = tool.domain;
      record.method = tool.method;
      record.path = tool.pathTemplate;

      if (tool.status === 'draft') {
        throw new ToolError(ErrorCode.APPROVAL_REQUIRED, `Tool "${tool.fqName}" is still a draft and cannot run.`, {
          hint: 'Review and approve it in the dashboard tool explorer.',
        });
      }
      if (tool.status === 'revoked') {
        throw new ToolError(ErrorCode.TOOL_REVOKED, `Tool "${tool.fqName}" has been revoked.`);
      }
      if (!this.store.isDomainEnabled(tool.domain)) {
        throw new ToolError(ErrorCode.DOMAIN_NOT_ALLOWED, `Domain "${tool.domain}" is not enabled.`, {
          hint: 'Enable the domain in the Websites view before calling its tools.',
        });
      }

      const validation = validateArguments(tool.inputSchema, request.args, tool.paramLocations);
      if (!validation.ok) {
        throw new ToolError(ErrorCode.INVALID_ARGUMENTS, 'Arguments do not match the tool schema.', {
          details: { errors: validation.errors.slice(0, 12) },
        });
      }

      const classification = classifyPermission(tool.method, tool.pathTemplate);
      if (classification.level === 'DESTRUCTIVE' && request.confirm !== true) {
        throw new ToolError(
          ErrorCode.CONFIRMATION_REQUIRED,
          `"${tool.fqName}" is destructive and requires an explicit confirmation.`,
          { hint: 'Pass confirm: true in the tool call arguments (exposed as the __confirm field) to proceed.' },
        );
      }

      if (!this.limiter.take(tool.fqName, this.store.settings.rateLimitPerMinute)) {
        throw new ToolError(ErrorCode.RATE_LIMITED, `Rate limit reached for "${tool.fqName}".`, {
          details: { limitPerMinute: this.store.settings.rateLimitPerMinute },
        });
      }

      const built = buildRequest(
        { pathTemplate: tool.pathTemplate, method: tool.method, paramLocations: tool.paramLocations },
        validation.value,
      );
      const domainConfig = this.store.getDomain(tool.domain);
      const origin =
        domainConfig?.origin ?? (isLoopbackDomain(tool.domain) ? `http://${tool.domain}` : `https://${tool.domain}`);
      let url = `${origin}${built.path}${built.query ? `?${built.query}` : ''}`;
      record.path = `${built.path}${built.query ? `?${built.query}` : ''}`;

      const checkedUrl = checkTargetUrl(url, tool.domain, { expectedOrigin: origin });
      if (!checkedUrl.ok) {
        throw new ToolError(checkedUrl.code ?? ErrorCode.INVALID_URL, checkedUrl.reason ?? 'URL rejected.');
      }

      const bodyText = built.body === undefined ? undefined : JSON.stringify(built.body);
      const requestBytes = bodyText ? jsonByteLength(bodyText) : 0;
      record.requestBytes = requestBytes;
      if (requestBytes > LIMITS.maxRequestBytes) {
        throw new ToolError(ErrorCode.REQUEST_TOO_LARGE, `Request body exceeds ${LIMITS.maxRequestBytes} bytes.`);
      }

      const timeoutMs = Math.min(this.store.settings.defaultTimeoutMs, LIMITS.maxTimeoutMs);

      let result = await this.dispatch(executionId, tool, url, bodyText, timeoutMs, domainConfig?.csrf);
      let redirects = 0;

      while (REDIRECT_STATUSES.has(result.status) && redirects < LIMITS.maxRedirects) {
        const location = result.headers?.location;
        if (!location) {
          throw new ToolError(ErrorCode.INVALID_RESPONSE, 'The website returned a redirect without a Location header.');
        }
        const verdict = checkRedirect(location, url, tool.domain);
        if (!verdict.ok || !verdict.url) {
          this.store.audit({
            kind: 'request.redirect_blocked',
            severity: 'warn',
            actor: request.actor,
            domain: tool.domain,
            toolName: tool.fqName,
            message: `Blocked a redirect away from ${tool.domain}.`,
            detail: { to: new URL(location, url).host },
          });
          throw new ToolError(ErrorCode.REDIRECT_BLOCKED, 'The website tried to redirect the request to another origin.', {
            details: { targetHost: safeHost(location, url) },
          });
        }
        redirects += 1;
        url = verdict.url.toString();
        result = await this.dispatch(executionId, tool, url, bodyText, timeoutMs, domainConfig?.csrf);
      }
      if (REDIRECT_STATUSES.has(result.status)) {
        throw new ToolError(ErrorCode.REDIRECT_BLOCKED, `More than ${LIMITS.maxRedirects} redirects; refusing to continue.`);
      }

      record.httpStatus = result.status;
      record.latencyMs = result.latencyMs;

      if (!result.ok) {
        const code = result.error?.code ?? ErrorCode.NETWORK_ERROR;
        record.outcome = code === ErrorCode.TIMEOUT ? 'timeout' : 'error';
        throw new ToolError(code, result.error?.message ?? 'The browser could not complete the request.', {
          hint: result.error?.hint,
        });
      }

      const safeHeaders = pickSafeHeaders(result.headers as Record<string, string>);
      const rawBody = result.body ?? '';
      const contentType = safeHeaders['content-type'] ?? '';
      const maxBytes = this.store.settings.maxResponseBytes;
      const truncated = result.truncated || rawBody.length > maxBytes;
      const responseText = truncated && rawBody.length > maxBytes ? rawBody.slice(0, maxBytes) : rawBody;

      let bodyValue: unknown = responseText;
      if (responseText.length === 0) {
        bodyValue = null;
      } else if (contentType.includes('json')) {
        try {
          bodyValue = JSON.parse(responseText);
        } catch {
          if (truncated) {
            bodyValue = responseText;
          } else {
            throw new ToolError(ErrorCode.INVALID_RESPONSE, 'The website declared JSON but the body could not be parsed.', {
              details: { status: result.status, bytes: rawBody.length },
            });
          }
        }
      }

      if (result.status === 401) {
        throw new ToolError(ErrorCode.WEBSITE_AUTH_EXPIRED, `The browser session for ${tool.domain} is not authenticated.`, {
          hint: `Sign in again at ${origin} in the same browser, then retry. No other request was attempted.`,
        });
      }
      if (result.status === 403) {
        throw new ToolError(ErrorCode.PERMISSION_DENIED, `The website refused this request for the signed-in user.`, {
          details: { status: 403, siteMessage: extractMessage(bodyValue) },
        });
      }
      if (result.status >= 500) {
        throw new ToolError(ErrorCode.WEBSITE_ERROR, `The website returned HTTP ${result.status}.`, {
          details: { status: result.status, siteMessage: extractMessage(bodyValue) },
        });
      }

      record.outcome = 'ok';
      record.responseBytes = rawBody.length;
      record.truncated = truncated;
      record.responsePreview = redactString(rawBody.slice(0, 1500));
      record.finishedAt = new Date().toISOString();

      this.store.addExecution({ ...record });
      this.store.noteToolExecution(tool.id, 'ok');
      this.store.audit({
        kind: 'tool.executed',
        severity: 'info',
        actor: request.actor,
        domain: tool.domain,
        toolName: tool.fqName,
        message: `${tool.method} ${tool.pathTemplate} -> ${result.status} in ${Math.round(result.latencyMs)} ms`,
        detail: { permission: tool.permission, executionId },
      });

      const envelope: ExecutionEnvelope = {
        ok: true,
        tool: tool.fqName,
        domain: tool.domain,
        method: tool.method,
        path: record.path,
        status: result.status,
        headers: safeHeaders,
        body: bodyValue,
        latencyMs: result.latencyMs,
        truncated,
        executionId,
      };
      if (result.statusText) envelope.statusText = result.statusText;
      return envelope;
    } catch (error) {
      const shape = toErrorShape(error);
      record.errorCode = shape.code;
      record.errorMessage = shape.message;
      record.finishedAt = new Date().toISOString();
      if (record.outcome !== 'timeout') {
        record.outcome =
          shape.code === ErrorCode.EXTENSION_DISCONNECTED
            ? 'disconnected'
            : shape.code === ErrorCode.TIMEOUT
              ? 'timeout'
              : classifyOutcome(shape.code);
      }
      this.store.addExecution({ ...record });
      if (tool) this.store.noteToolExecution(tool.id, record.outcome);
      this.store.audit({
        kind: record.outcome === 'rejected' ? 'tool.rejected' : 'tool.failed',
        severity: record.outcome === 'rejected' ? 'warn' : 'error',
        actor: request.actor,
        domain: tool?.domain ?? null,
        toolName: tool?.fqName ?? request.tool,
        message: `${shape.code}: ${shape.message}`,
        detail: { executionId, hint: shape.hint },
      });
      this.logger.warn('tool.execution_failed', { code: shape.code, tool: tool?.fqName ?? request.tool });

      const envelope: ExecutionEnvelope = {
        ok: false,
        tool: tool?.fqName ?? request.tool,
        domain: tool?.domain ?? record.domain,
        method: tool?.method ?? record.method,
        path: record.path,
        status: record.httpStatus ?? 0,
        headers: {},
        body: null,
        latencyMs: record.latencyMs ?? 0,
        truncated: false,
        executionId,
        error: shape,
      };
      return envelope;
    }
  }

  private async dispatch(
    executionId: string,
    tool: ToolRecord,
    url: string,
    bodyText: string | undefined,
    timeoutMs: number,
    csrf: { bootstrapPath: string; tokenField: string; header: string } | undefined,
  ): Promise<ResultMessage> {
    const message: ExecuteMessage = {
      type: 'execute',
      id: `${executionId}:${Math.random().toString(36).slice(2, 8)}`,
      method: tool.method as ExecuteMessage['method'],
      url,
      domain: tool.domain,
      headers: { accept: 'application/json, text/plain;q=0.9, */*;q=0.8' },
      timeoutMs,
    };
    if (bodyText !== undefined) {
      message.body = bodyText;
      message.headers['content-type'] = 'application/json';
    }
    if (csrf && tool.method !== 'GET' && tool.method !== 'HEAD') message.csrf = csrf;
    return this.hub.execute(message);
  }
}

function classifyOutcome(code: string): 'rejected' | 'error' {
  const rejected = new Set<string>([
    ErrorCode.DOMAIN_NOT_ALLOWED,
    ErrorCode.TOOL_NOT_APPROVED,
    ErrorCode.TOOL_REVOKED,
    ErrorCode.PERMISSION_DENIED,
    ErrorCode.CONFIRMATION_REQUIRED,
    ErrorCode.RATE_LIMITED,
    ErrorCode.APPROVAL_REQUIRED,
    ErrorCode.INVALID_ARGUMENTS,
    ErrorCode.UNKNOWN_TOOL,
    ErrorCode.INVALID_URL,
    ErrorCode.URL_SCHEME_NOT_ALLOWED,
    ErrorCode.CROSS_DOMAIN_BLOCKED,
    ErrorCode.REDIRECT_BLOCKED,
    ErrorCode.PRIVATE_ADDRESS_BLOCKED,
    ErrorCode.REQUEST_TOO_LARGE,
    ErrorCode.UNSUPPORTED_CONTENT_TYPE,
  ]);
  return rejected.has(code) ? 'rejected' : 'error';
}

function extractMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const message = record.message ?? record.error;
  return typeof message === 'string' ? message.slice(0, 300) : null;
}

function safeHost(location: string, base: string): string {
  try {
    return new URL(location, base).host;
  } catch {
    return 'unparseable';
  }
}
