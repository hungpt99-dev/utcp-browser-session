/**
 * Domain and URL policy.
 *
 * The security model is: a tool may only ever talk to the exact domain it was
 * discovered on. Everything here is pure and side-effect free so it can run
 * identically inside the extension, the runtime and the tests.
 */
import { ErrorCode, ToolError } from './errors.ts';

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const CONTROL_OR_SPACE = /[\u0000-\u0020\u007f]/;
const ENCODED_CRLF = /%(0d|0a|09)/i;

export const MAX_URL_LENGTH = 2048;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Reduce arbitrary user or URL input to a bare lowercase hostname.
 * Returns an empty string when nothing usable is left.
 */
export function normalizeDomain(input: string): string {
  let raw = String(input ?? '').trim().toLowerCase();
  if (!raw) return '';

  const scheme = raw.match(/^[a-z][a-z0-9+.-]*:\/\//);
  if (scheme) raw = raw.slice(scheme[0].length);

  if (raw.includes('@')) raw = raw.slice(raw.lastIndexOf('@') + 1);

  const cut = raw.search(/[/?#]/);
  if (cut >= 0) raw = raw.slice(0, cut);

  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end > 0) raw = raw.slice(0, end + 1);
  } else {
    const colon = raw.lastIndexOf(':');
    if (colon > 0 && /^\d+$/.test(raw.slice(colon + 1))) raw = raw.slice(0, colon);
  }

  if (raw.endsWith('.')) raw = raw.slice(0, -1);
  return raw;
}

export function isLoopbackDomain(domain: string): boolean {
  const d = normalizeDomain(domain);
  return LOOPBACK_HOSTS.has(d) || d.startsWith('127.');
}

export function isValidDomain(domain: string): boolean {
  const d = normalizeDomain(domain);
  if (!d) return false;
  if (LOOPBACK_HOSTS.has(d)) return true;
  if (IPV4_RE.test(d)) return false; // bare IP literals are never a normal website
  return DOMAIN_RE.test(d);
}

/** True for any address a request must never be aimed at (SSRF surface). */
export function isPrivateAddress(domain: string): boolean {
  const d = normalizeDomain(domain);
  if (LOOPBACK_HOSTS.has(d)) return false; // local test site is an explicit, supported case
  if (!IPV4_RE.test(d)) return false;
  const [a, b] = d.split('.').map((n) => Number(n));
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export interface UrlCheckResult {
  ok: boolean;
  url?: URL;
  code?: string;
  reason?: string;
}

/**
 * Normalize user input ("example.com", "https://example.com/app",
 * "127.0.0.1:8788") into a hostname plus the exact origin a tool may call.
 * The hostname is the security key; the origin pins scheme and port.
 */
export function parseDomainInput(input: string): { domain: string; origin: string } | null {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw
    : isLoopbackDomain(normalizeDomain(raw))
      ? `http://${raw}`
      : `https://${raw}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;

  const domain = normalizeDomain(url.hostname);
  if (!isValidDomain(domain)) return null;
  if (url.protocol === 'http:' && !isLoopbackDomain(domain)) return null;

  const scheme = url.protocol.replace(':', '');
  const port = url.port ? `:${url.port}` : '';
  return { domain, origin: `${scheme}://${domain}${port}` };
}

/**
 * Validate that `rawUrl` targets exactly `expectedDomain`, using only safe
 * schemes, with no credential material and no traversal segments. When
 * `expectedOrigin` is supplied, scheme and port must match it exactly.
 */
export function checkTargetUrl(
  rawUrl: string,
  expectedDomain: string,
  options: { allowHttp?: boolean; expectedOrigin?: string } = {},
): UrlCheckResult {
  const domain = normalizeDomain(expectedDomain);
  if (!domain) return { ok: false, code: ErrorCode.DOMAIN_NOT_ALLOWED, reason: 'No domain was provided.' };
  if (isPrivateAddress(domain)) return { ok: false, code: ErrorCode.PRIVATE_ADDRESS_BLOCKED, reason: 'Private network addresses are not allowed.' };
  if (!isValidDomain(domain)) return { ok: false, code: ErrorCode.DOMAIN_NOT_ALLOWED, reason: 'Domain is not a valid hostname.' };

  const raw = String(rawUrl ?? '');
  if (!raw) return { ok: false, code: ErrorCode.INVALID_URL, reason: 'Empty URL.' };
  if (raw.length > MAX_URL_LENGTH) return { ok: false, code: ErrorCode.INVALID_URL, reason: 'URL is longer than 2048 characters.' };
  if (CONTROL_OR_SPACE.test(raw)) return { ok: false, code: ErrorCode.INVALID_URL, reason: 'URL contains control characters or whitespace.' };
  if (raw.includes('\\')) return { ok: false, code: ErrorCode.INVALID_URL, reason: 'URL contains a backslash.' };
  if (ENCODED_CRLF.test(raw)) return { ok: false, code: ErrorCode.INVALID_URL, reason: 'URL contains encoded control characters.' };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: ErrorCode.INVALID_URL, reason: 'URL could not be parsed.' };
  }

  const scheme = url.protocol.replace(':', '').toLowerCase();
  const local = isLoopbackDomain(domain);

  if (scheme === 'https') {
    // always fine
  } else if (scheme === 'http') {
    if (!local && options.allowHttp !== true) {
      return { ok: false, code: ErrorCode.URL_SCHEME_NOT_ALLOWED, reason: 'Plain HTTP is only allowed for loopback domains.' };
    }
  } else {
    return { ok: false, code: ErrorCode.URL_SCHEME_NOT_ALLOWED, reason: `Scheme "${scheme}" is not allowed.` };
  }

  if (url.username || url.password) {
    return { ok: false, code: ErrorCode.INVALID_URL, reason: 'URLs must not embed credentials.' };
  }

  if (url.hostname.toLowerCase() !== domain) {
    return {
      ok: false,
      code: ErrorCode.CROSS_DOMAIN_BLOCKED,
      reason: `Request targets "${url.hostname}" but the tool is bound to "${domain}".`,
    };
  }

  if (options.expectedOrigin && url.origin !== options.expectedOrigin) {
    return {
      ok: false,
      code: ErrorCode.CROSS_DOMAIN_BLOCKED,
      reason: `Request targets ${url.origin} but this domain is pinned to ${options.expectedOrigin}.`,
    };
  }

  const segments = url.pathname.split('/');
  for (const segment of segments) {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return { ok: false, code: ErrorCode.INVALID_URL, reason: 'URL path contains invalid percent-encoding.' };
    }
    if (decoded === '..' || decoded === '.') {
      return { ok: false, code: ErrorCode.INVALID_URL, reason: 'URL path contains traversal segments.' };
    }
  }

  return { ok: true, url };
}

/**
 * Validate a redirect destination against the tool's own domain. Called by the
 * runtime *and* by the extension, so a redirect can never collapse into an
 * off-domain request.
 */
export function checkRedirect(rawLocation: string, fromUrl: string, expectedDomain: string): UrlCheckResult {
  let resolved: URL;
  try {
    resolved = new URL(rawLocation, fromUrl);
  } catch {
    return { ok: false, code: ErrorCode.REDIRECT_BLOCKED, reason: 'Redirect location could not be parsed.' };
  }
  return checkTargetUrl(resolved.toString(), expectedDomain);
}

/** True when two URLs share scheme + host + port. */
export function isSameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export function assertTargetUrl(rawUrl: string, expectedDomain: string): URL {
  const result = checkTargetUrl(rawUrl, expectedDomain);
  if (!result.ok || !result.url) {
    throw new ToolError(result.code ?? ErrorCode.INVALID_URL, result.reason ?? 'URL rejected.', {
      details: { domain: normalizeDomain(expectedDomain) },
    });
  }
  return result.url;
}
