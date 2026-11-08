/**
 * Redaction helpers.
 *
 * These are applied to everything the runtime writes down (audit events, logs,
 * execution records, error payloads). They are intentionally aggressive: a
 * false positive costs a little debugging detail, a false negative leaks a
 * session.
 */
export const REDACTED = '[REDACTED]';

/** Headers that may never leave the browser or reach a log file. */
export const SECRET_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-csrf-token',
  'x-xsrf-token',
  'x-api-key',
  'x-auth-token',
  'api-key',
  'x-session-id',
  'x-amz-security-token',
]);

/**
 * Response headers that are safe to surface to an agent. Anything not listed is
 * dropped entirely rather than redacted, so the tool response can never carry
 * `set-cookie`.
 */
export const SAFE_RESPONSE_HEADERS: readonly string[] = ['content-type', 'content-length', 'etag', 'x-request-id', 'retry-after'];

const SECRET_KEY_RE =
  /(pass(word|phrase)?|secret|token|api[-_]?key|apikey|authorization|auth[-_]?header|cookie|session[-_]?id|credential|private[-_]?key|bearer)/i;

const BEARER_RE = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const COOKIE_PAIR_RE = /\b([A-Za-z0-9_-]{2,32})=([^\s;]{6,})\b/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
const LONG_TOKEN_RE = /\b[A-Za-z0-9_-]{40,}\b/g;

export function redactString(input: string): string {
  // A bare cookie name without a matching header context is still sensitive
  // when it is one of ours; the header-level filter handles that case, so here
  // we only strip value patterns that cannot be legitimate tool output.
  return input.replace(BEARER_RE, REDACTED).replace(JWT_RE, REDACTED).replace(LONG_TOKEN_RE, REDACTED).replace(COOKIE_PAIR_RE, (_m, name: string) => `${name}=${REDACTED}`);
}

export function isSecretKey(key: string): boolean {
  return SECRET_HEADERS.has(key.toLowerCase()) || SECRET_KEY_RE.test(key);
}

/**
 * Keep only headers that are safe to show, and never return `set-cookie` or
 * authentication material even if a caller passes them in.
 */
export function pickSafeHeaders(headers: Record<string, string | string[]> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (SECRET_HEADERS.has(name)) continue;
    if (!SAFE_RESPONSE_HEADERS.includes(name)) continue;
    out[name] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

/** Redact a header map for logging: secret values are replaced, names are kept. */
export function redactHeaders(headers: Record<string, string | string[]> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (SECRET_HEADERS.has(name) || isSecretKey(name)) {
      out[name] = REDACTED;
      continue;
    }
    out[name] = Array.isArray(value) ? value.map((v) => redactString(String(v))).join(', ') : redactString(String(value));
  }
  return out;
}

const MAX_DEPTH = 8;

/**
 * Deep-redact an object by key name and by value pattern. Used for audit
 * details and for anything echoed back into an error.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretKey(key) ? REDACTED : redactValue(item, depth + 1);
    }
    return out;
  }
  return REDACTED;
}
