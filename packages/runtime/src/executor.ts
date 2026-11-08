/**
 * Execution pipeline.
 *
 * Every invocation walks the same path, in this order:
 *   resolve tool -> approval -> origin allowlist -> domain policy -> argument
 *   validation -> confirmation -> rate limit -> URL construction -> URL policy ->
 *   size limits -> browser dispatch -> response normalization -> audit.
 *
 * There is no branch that falls back to a direct HTTP request: if the browser
 * cannot perform the call, the call fails.
 *
 * The permission used at execution time is the one recorded on the tool (set by
 * classification *and* human review), clamped by the domain policy. It is never
 * recomputed from the HTTP method at call time, so an agent cannot talk its way
 * past a reviewed classification.
 */
import {
  ErrorCode,
  LIMITS,
  PERMISSION_ORDER,
  ToolError,
  buildRequest,
  checkRedirect,
  checkTargetUrl,
  jsonByteLength,
  pickSafeHeaders,
  redactString,
  requiresConfirmation,
  toErrorShape,
  validateArguments,
  type ExecuteMessage,
  type ExecuteRequest,
  type ExecutionEnvelope,
  type ExecutionRecord,
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
    // Bound the map: keys idle for more than a window cannot affect any result.
    if (this.hits.size > 500) {
      for (const [staleKey, timestamps] of this.hits) {
        if (timestamps.every((ts) => ts <= windowStart)) this.hits.delete(staleKey);
      }
    }
    return true;
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Hooks let the HTTP layer cancel a call when the client hangs up. */
export interface ExecuteHooks {
  onDispatched?: (dispatchId: string) => void;
}

/** Map an error code onto the category shown in the observability records. */
function errorCategory(code: string): ExecutionRecord['errorCategory'] {
  if (
    [
      ErrorCode.DOMAIN_NOT_ALLOWED,
      ErrorCode.TOOL_NOT_APPROVED,
      ErrorCode.TOOL_REVOKED,
      ErrorCode.PERMISSION_DENIED,
      ErrorCode.CONFIRMATION_REQUIRED,
      ErrorCode.RATE_LIMITED,
      ErrorCode.APPROVAL_REQUIRED,
      ErrorCode.POLICY_BLOCKED,
      ErrorCode.BUSY,
      ErrorCode.NO_BROWSER,
    ].includes(code as never)
  ) {
    return 'policy';
  }
  if (
    [
      ErrorCode.INVALID_ARGUMENTS,
      ErrorCode.UNKNOWN_TOOL,
      ErrorCode.INVALID_URL,
      ErrorCode.URL_SCHEME_NOT_ALLOWED,
      ErrorCode.CROSS_DOMAIN_BLOCKED,
      ErrorCode.REDIRECT_BLOCKED,
      ErrorCode.PRIVATE_ADDRESS_BLOCKED,
      ErrorCode.REQUEST_TOO_LARGE,
      ErrorCode.UNSUPPORTED_CONTENT_TYPE,
      ErrorCode.INVALID_REQUEST,
    ].includes(code as never)
  ) {
    return 'validation';
  }
  if (code === ErrorCode.WEBSITE_AUTH_EXPIRED || code === ErrorCode.AUTH_REQUIRED) return 'auth';
  if (code === ErrorCode.NETWORK_ERROR || code === ErrorCode.TIMEOUT || code === ErrorCode.ABORTED || code === ErrorCode.EXTENSION_DISCONNECTED) {
    return 'transport';
  }
  if (code === ErrorCode.WEBSITE_ERROR || code === ErrorCode.INVALID_RESPONSE || code === ErrorCode.RESPONSE_TOO_LARGE) return 'upstream';
  return 'internal';
}

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

  async execute(request: ExecuteRequest, hooks: ExecuteHooks = {}): Promise<ExecutionEnvelope> {
    const startedAt = new Date();
    const startedMs = Date.now();
    const executionId = generateId('exec');
    const correlationId = request.correlationId ?? executionId;
    let tool: ToolRecord | undefined;

    const record: ExecutionRecord = {
      id: executionId,
      correlationId,
      toolId: '',
      toolName: request.tool,
      domain: '',
      origin: '',
      method: '',
      path: '',
      actor: request.actor,
      outcome: 'rejected',
      httpStatus: null,
      latencyMs: null,
      queuedMs: null,
      startedAt: startedAt.toISOString(),
      finishedAt: null,
      requestBytes: null,
      responseBytes: null,
      truncated: false,
      errorCode: null,
      errorCategory: null,
      errorMessage: null,
      permission: 'READ',
      permissionDecision: 'denied',
      approvalDecision: 'n/a',
      responsePreview: null,
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
      record.origin = tool.origin;
      record.method = tool.method;
      record.path = tool.pathTemplate;
      record.permission = tool.permission;
      record.approvalDecision = tool.status === 'approved' ? 'approved' : tool.status;

      if (tool.status === 'draft') {
        throw new ToolError(ErrorCode.APPROVAL_REQUIRED, `Tool "${tool.fqName}" is still a draft and cannot run.`, {
          hint: 'Review and approve it in the dashboard tool explorer.',
        });
      }
      if (tool.status === 'revoked') {
        throw new ToolError(ErrorCode.TOOL_REVOKED, `Tool "${tool.fqName}" has been revoked.`);
      }

      const domainConfig = this.store.getDomain(tool.origin);
      if (!domainConfig || !domainConfig.enabled) {
        throw new ToolError(ErrorCode.DOMAIN_NOT_ALLOWED, `Origin "${tool.origin}" is not enabled.`, {
          hint: 'Enable the website in the Websites view before calling its tools.',
        });
      }

      // Defence in depth: the policy may have been tightened after approval.
      if (PERMISSION_ORDER[tool.permission] > PERMISSION_ORDER[domainConfig.policy.maxPermission]) {
        throw new ToolError(
          ErrorCode.POLICY_BLOCKED,
          `The domain policy for ${tool.origin} caps tools at ${domainConfig.policy.maxPermission}, but "${tool.fqName}" is ${tool.permission}.`,
          { hint: 'Raise the domain ceiling or re-classify the tool.' },
        );
      }

      const validation = validateArguments(tool.inputSchema, request.args, tool.paramLocations);
      if (!validation.ok) {
        throw new ToolError(ErrorCode.INVALID_ARGUMENTS, 'Arguments do not match the tool schema.', {
          details: { errors: validation.errors.slice(0, 12) },
        });
      }

      if (requiresConfirmation(tool.permission, domainConfig.policy.confirmWrites) && request.confirm !== true) {
        throw new ToolError(
          ErrorCode.CONFIRMATION_REQUIRED,
          `"${tool.fqName}" is ${tool.permission.toLowerCase()} and requires an explicit confirmation.`,
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
      const origin = domainConfig.origin;
      let url = `${origin}${built.path}${built.query ? `?${built.query}` : ''}`;
      // The query string can carry a token (`access_token=...`), so the stored
      // path is redacted before it reaches the execution record or the audit log.
      record.path = redactString(`${built.path}${built.query ? `?${built.query}` : ''}`);
      record.permissionDecision = 'allowed';

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

      let dispatchedAt = Date.now();
      let result = await this.dispatch(correlationId, tool, url, bodyText, timeoutMs, domainConfig.csrf, hooks);
      record.queuedMs = Date.now() - dispatchedAt - Math.round(result.latencyMs);
      let redirects = 0;

      while (REDIRECT_STATUSES.has(result.status) && redirects < LIMITS.maxRedirects) {
        const location = result.headers?.location;
        if (!location) {
          throw new ToolError(ErrorCode.INVALID_RESPONSE, 'The website returned a redirect without a Location header.');
        }
        const verdict = checkRedirect(location, url, tool.domain, { expectedOrigin: origin });
        if (!verdict.ok || !verdict.url) {
          this.store.audit({
            kind: 'request.redirect_blocked',
            severity: 'warn',
            actor: request.actor,
            origin: tool.origin,
            toolName: tool.fqName,
            correlationId,
            message: `Blocked a redirect away from ${tool.domain}.`,
            detail: { to: safeHost(location, url) },
          });
          throw new ToolError(ErrorCode.REDIRECT_BLOCKED, 'The website tried to redirect the request to another origin.', {
            details: { targetHost: safeHost(location, url) },
          });
        }
        redirects += 1;
        url = verdict.url.toString();
        dispatchedAt = Date.now();
        result = await this.dispatch(correlationId, tool, url, bodyText, timeoutMs, domainConfig.csrf, hooks);
        record.queuedMs = (record.queuedMs ?? 0) + (Date.now() - dispatchedAt - Math.round(result.latencyMs));
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
        this.store.setSession(tool.origin, 'expired', 401, ErrorCode.WEBSITE_AUTH_EXPIRED);
        this.store.audit({
          kind: 'session.expired',
          severity: 'warn',
          actor: request.actor,
          origin: tool.origin,
          toolName: tool.fqName,
          correlationId,
          message: `The website answered 401 for ${tool.origin}; the browser session is no longer valid.`,
        });
        throw new ToolError(ErrorCode.WEBSITE_AUTH_EXPIRED, `The browser session for ${tool.domain} is not authenticated.`, {
          hint: `Sign in again at ${origin} in the same browser, then retry. No other request was attempted.`,
        });
      }
      if (result.status === 403) {
        throw new ToolError(ErrorCode.PERMISSION_DENIED, 'The website refused this request for the signed-in user.', {
          details: { status: 403, siteMessage: extractMessage(bodyValue) },
        });
      }
      if (result.status >= 500) {
        throw new ToolError(ErrorCode.WEBSITE_ERROR, `The website returned HTTP ${result.status}.`, {
          details: { status: result.status, siteMessage: extractMessage(bodyValue) },
        });
      }

      this.store.setSession(tool.origin, 'ok', result.status, null);
      this.store.touchDomain(tool.origin);
      record.outcome = 'ok';
      record.responseBytes = rawBody.length;
      record.truncated = truncated;
      record.responsePreview = redactString(rawBody.slice(0, 1500));
      record.finishedAt = new Date().toISOString();
      record.latencyMs = Date.now() - startedMs;

      this.store.addExecution(record);
      this.store.noteToolExecution(tool.id, 'ok');
      this.store.audit({
        kind: 'tool.executed',
        severity: 'info',
        actor: request.actor,
        origin: tool.origin,
        toolName: tool.fqName,
        correlationId,
        message: `${tool.method} ${tool.pathTemplate} -> ${result.status} in ${Math.round(result.latencyMs)} ms`,
        detail: { permission: tool.permission, executionId, queuedMs: record.queuedMs },
      });
      this.logger.info('tool.executed', {
        executionId,
        correlationId,
        origin: tool.origin,
        tool: tool.fqName,
        status: result.status,
        latencyMs: Math.round(record.latencyMs ?? 0),
        permission: tool.permission,
      });

      const envelope: ExecutionEnvelope = {
        ok: true,
        tool: tool.fqName,
        domain: tool.domain,
        origin: tool.origin,
        method: tool.method,
        path: record.path,
        status: result.status,
        headers: safeHeaders,
        body: bodyValue,
        latencyMs: result.latencyMs,
        truncated,
        executionId,
        correlationId,
      };
      if (result.statusText) envelope.statusText = result.statusText;
      const pagination = extractPagination(tool, bodyValue);
      if (pagination) envelope.pagination = pagination;
      return envelope;
    } catch (error) {
      const shape = toErrorShape(error);
      record.errorCode = shape.code;
      record.errorCategory = errorCategory(shape.code);
      record.errorMessage = redactString(shape.message);
      record.finishedAt = new Date().toISOString();
      if (record.latencyMs === null) record.latencyMs = Date.now() - startedMs;
      if (record.outcome !== 'timeout') {
        record.outcome =
          shape.code === ErrorCode.EXTENSION_DISCONNECTED
            ? 'disconnected'
            : shape.code === ErrorCode.TIMEOUT
              ? 'timeout'
              : classifyOutcome(shape.code);
      }
      if (record.outcome === 'rejected') {
        record.permissionDecision = shape.code === ErrorCode.CONFIRMATION_REQUIRED ? 'confirmation_required' : 'denied';
      }
      this.store.addExecution(record);
      if (tool) this.store.noteToolExecution(tool.id, record.outcome);
      this.store.audit({
        kind: record.outcome === 'rejected' ? 'tool.rejected' : 'tool.failed',
        severity: record.outcome === 'rejected' ? 'warn' : 'error',
        actor: request.actor,
        origin: tool?.origin ?? null,
        toolName: tool?.fqName ?? request.tool,
        correlationId,
        message: `${shape.code}: ${shape.message}`,
        detail: { executionId, hint: shape.hint, category: record.errorCategory },
      });
      this.logger.warn('tool.execution_failed', {
        executionId,
        correlationId,
        code: shape.code,
        category: record.errorCategory,
        tool: tool?.fqName ?? request.tool,
      });

      const envelope: ExecutionEnvelope = {
        ok: false,
        tool: tool?.fqName ?? request.tool,
        domain: tool?.domain ?? record.domain,
        origin: tool?.origin ?? record.origin,
        method: tool?.method ?? record.method,
        path: record.path,
        status: record.httpStatus ?? 0,
        headers: {},
        body: null,
        latencyMs: record.latencyMs ?? 0,
        truncated: false,
        executionId,
        correlationId,
        error: shape,
      };
      return envelope;
    }
  }

  private async dispatch(
    correlationId: string,
    tool: ToolRecord,
    url: string,
    bodyText: string | undefined,
    timeoutMs: number,
    csrf: { bootstrapPath: string; tokenField: string; header: string } | undefined,
    hooks: ExecuteHooks,
  ): Promise<ResultMessage> {
    const message: ExecuteMessage = {
      type: 'execute',
      id: `${correlationId}:${Math.random().toString(36).slice(2, 8)}`,
      correlationId,
      method: tool.method as ExecuteMessage['method'],
      url,
      origin: tool.origin,
      headers: { accept: 'application/json, text/plain;q=0.9, */*;q=0.8' },
      timeoutMs,
    };
    if (bodyText !== undefined) {
      message.body = bodyText;
      message.headers['content-type'] = 'application/json';
    }
    if (csrf && tool.method !== 'GET' && tool.method !== 'HEAD') message.csrf = csrf;
    hooks.onDispatched?.(message.id);
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
    ErrorCode.POLICY_BLOCKED,
    ErrorCode.BUSY,
    ErrorCode.NO_BROWSER,
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

/** Surface pagination cursors from a response that carries them. */
function extractPagination(
  tool: ToolRecord,
  body: unknown,
): { next: string | null; total: number | null } | undefined {
  if (!tool.pagination || !body || typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;
  const nextField = tool.pagination.nextField;
  const next = nextField && typeof record[nextField] === 'string' ? (record[nextField] as string) : null;
  let total: number | null = null;
  for (const key of ['total', 'totalCount', 'total_count', 'count']) {
    if (typeof record[key] === 'number') {
      total = record[key] as number;
      break;
    }
  }
  return { next, total };
}
