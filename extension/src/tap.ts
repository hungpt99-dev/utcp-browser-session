/**
 * Page-context schema tap (MAIN world).
 *
 * MV3's `webRequest` cannot see request or response bodies, so structural
 * inference happens here instead. This code:
 *
 *   - never reads cookie or authorization headers (it only records whether a
 *     CSRF-style header *name* was present),
 *   - never records values, only JSON *types* (plus `format: date-time`),
 *   - optionally records *enum-like* value sets for a short allowlist of
 *     semantic field names, and only for token-shaped values (see `enumSample`),
 *   - caps depth, property count and value length,
 *   - is a no-op if anything about the page looks unexpected.
 *
 * The isolated-world bridge relays these messages to the service worker, which
 * drops them unless the user enabled schema capture for that origin.
 */
(() => {
  const TAG = '__utcp_tap__';
  const MAX_DEPTH = 5;
  const MAX_PROPS = 40;
  const MAX_ENUM_FIELDS = 12;
  const MAX_ENUM_VALUES = 8;
  const MAX_ENUM_VALUE_LENGTH = 24;

  if ((window as unknown as Record<string, unknown>)[TAG]) return;
  (window as unknown as Record<string, unknown>)[TAG] = true;

  const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
  /**
   * Fields whose values are safe to sample: they name a category, never a
   * person, a message or a credential. The value must also look like a token
   * (no spaces, no @, no digits-only blobs), which excludes emails, prose,
   * tokens and ids.
   */
  const ENUM_FIELD = /(status|state|type|kind|category|priority|level|role|visibility|mode|stage|severity|resolution)$/i;
  const TOKEN_VALUE = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;

  function shape(value: unknown, depth = 0): Record<string, unknown> {
    if (depth > MAX_DEPTH) return { type: 'unknown' };
    if (value === null) return { type: 'null' };
    const type = typeof value;
    if (type === 'string') {
      return timestamp.test(value as string) ? { type: 'string', format: 'date-time' } : { type: 'string' };
    }
    if (type === 'number' || type === 'boolean') return { type };
    if (Array.isArray(value)) {
      return { type: 'array', items: value.length ? shape(value[0], depth + 1) : {} };
    }
    if (type === 'object') {
      const properties: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).slice(0, MAX_PROPS)) {
        properties[key] = shape((value as Record<string, unknown>)[key], depth + 1);
      }
      return { type: 'object', properties };
    }
    return { type: 'unknown' };
  }

  /** Collect short enum-like values from the top level of an object. */
  function enumSample(value: unknown, out: Record<string, string[]>, depth = 0): void {
    if (depth > 2 || !value || typeof value !== 'object') return;
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return;
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (Object.keys(out).length >= MAX_ENUM_FIELDS) return;
        if (typeof child === 'string' && ENUM_FIELD.test(key) && TOKEN_VALUE.test(child)) {
          const bucket = out[key] ?? [];
          if (!bucket.includes(child) && bucket.length < MAX_ENUM_VALUES && child.length <= MAX_ENUM_VALUE_LENGTH) {
            bucket.push(child);
            out[key] = bucket;
          }
        } else if (Array.isArray(child) && child.length > 0) {
          walk(child[0]);
        } else if (child && typeof child === 'object') {
          walk(child);
        }
      }
    };
    walk(value);
  }

  function emit(payload: Record<string, unknown>): void {
    try {
      window.postMessage({ [TAG]: true, payload }, location.origin);
    } catch {
      /* cross-origin frame or detached window */
    }
  }

  function isJsonRequest(body: unknown): body is string {
    if (typeof body !== 'string' || body.length === 0 || body.length > 64 * 1024) return false;
    const first = body.trimStart()[0];
    return first === '{' || first === '[';
  }

  function safeParse(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  /** Read a header value without ever forwarding it. */
  function headerNames(headers: unknown): string[] {
    if (!headers) return [];
    if (headers instanceof Headers) return [...headers.keys()];
    if (Array.isArray(headers)) return (headers as Array<[string, string]>).map((pair) => String(pair[0]));
    if (typeof headers === 'object') return Object.keys(headers as Record<string, unknown>);
    return [];
  }

  const CSRF_HEADER = /(csrf|xsrf)/i;

  interface RequestAnalysis {
    shape?: Record<string, unknown>;
    enums?: Record<string, string[]>;
    graphqlOperation?: string;
    csrfHeader?: boolean;
    requestBytes?: number;
  }

  function analyzeRequest(body: unknown, headers: unknown): RequestAnalysis {
    const info: RequestAnalysis = {};
    if (typeof body === 'string' && body.length > 0) info.requestBytes = body.length;
    if (headerNames(headers).some((name) => CSRF_HEADER.test(name))) info.csrfHeader = true;
    if (!isJsonRequest(body)) return info;

    const parsed = safeParse(body);
    if (parsed === undefined) return info;
    info.shape = shape(parsed);

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const operationName = typeof record.operationName === 'string' ? record.operationName : undefined;
      const query = typeof record.query === 'string' ? record.query : undefined;
      if (operationName && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(operationName)) {
        info.graphqlOperation = operationName;
      } else if (query) {
        // `query GetIssue($id: ID!)` / `mutation UpdateIssue { ... }`
        const match = /^\s*(?:query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]{0,63})/.exec(query);
        if (match) info.graphqlOperation = match[1];
      }
      const enums: Record<string, string[]> = {};
      enumSample(record.variables ?? record, enums);
      if (Object.keys(enums).length > 0) info.enums = enums;
    }
    return info;
  }

  function analyzeResponse(value: unknown, text: string): RequestAnalysis {
    const info: RequestAnalysis = {};
    if (typeof text === 'string') info.requestBytes = undefined;
    if (value !== undefined) {
      const enums: Record<string, string[]> = {};
      enumSample(value, enums);
      if (Object.keys(enums).length > 0) info.enums = enums;
    }
    return info;
  }

  function report(
    url: string,
    method: string,
    status: number,
    contentType: string,
    request: RequestAnalysis,
    responseShape?: Record<string, unknown>,
    responseEnums?: Record<string, string[]>,
    responseBytes?: number,
  ): void {
    const enums = { ...(request.enums ?? {}), ...(responseEnums ?? {}) };
    // Always report an absolute URL: a relative "/api/tasks" resolved against a
    // portless base would lose the origin's port and look like a different site.
    let absolute = url;
    try {
      absolute = new URL(url, location.href).toString();
    } catch {
      /* keep the raw value; the service worker validates it again */
    }
    emit({
      kind: 'http',
      url: absolute,
      method,
      status,
      contentType,
      requestShape: request.shape ?? null,
      responseShape: responseShape ?? null,
      ...(Object.keys(enums).length > 0 ? { enums } : {}),
      ...(request.csrfHeader ? { csrfHeader: true } : {}),
      ...(request.graphqlOperation ? { graphqlOperation: request.graphqlOperation } : {}),
      ...(typeof request.requestBytes === 'number' ? { requestBytes: request.requestBytes } : {}),
      ...(typeof responseBytes === 'number' ? { responseBytes } : {}),
    });
  }

  // --- fetch ---------------------------------------------------------------
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const request = init ?? {};
      let url = '';
      let method = 'GET';
      try {
        url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        method = (request.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      } catch {
        return originalFetch.call(window, input as RequestInfo, init);
      }

      const analyzed = analyzeRequest(request.body, request.headers);

      let promise: Promise<Response>;
      try {
        promise = originalFetch.call(window, input as RequestInfo, init);
      } catch (error) {
        throw error;
      }

      return promise.then((response) => {
        try {
          const contentType = response.headers.get('content-type') ?? '';
          if (contentType.includes('json')) {
            response
              .clone()
              .text()
              .then((text) => {
                if (!text || text.length > 512 * 1024) {
                  report(url, method, response.status, contentType, analyzed);
                  return;
                }
                const parsed = safeParse(text);
                const extra = analyzeResponse(parsed, text);
                report(
                  url,
                  method,
                  response.status,
                  contentType,
                  analyzed,
                  parsed === undefined ? undefined : shape(parsed),
                  extra.enums,
                  text.length,
                );
              })
              .catch(() => undefined);
          } else {
            report(url, method, response.status, contentType, analyzed);
          }
        } catch {
          /* ignore instrumentation failures */
        }
        return response;
      });
    } as typeof window.fetch;
  }

  // --- XMLHttpRequest ------------------------------------------------------
  const OriginalXhr = window.XMLHttpRequest;
  if (typeof OriginalXhr === 'function') {
    const open = OriginalXhr.prototype.open;
    const send = OriginalXhr.prototype.send;
    const state = new WeakMap<XMLHttpRequest, { url: string; method: string; request: RequestAnalysis }>();

    OriginalXhr.prototype.open = function patchedOpen(this: XMLHttpRequest, method: string, url: string | URL) {
      try {
        const absolute = new URL(String(url), location.href).toString();
        state.set(this, { url: absolute, method: String(method || 'GET').toUpperCase(), request: {} });
      } catch {
        /* ignore */
      }
      return open.apply(this, arguments as never);
    } as typeof OriginalXhr.prototype.open;

    OriginalXhr.prototype.send = function patchedSend(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      const entry = state.get(this);
      if (entry) {
        entry.request = analyzeRequest(body, undefined);
        this.addEventListener('loadend', () => {
          try {
            const contentType = this.getResponseHeader('content-type') ?? '';
            if (!contentType.includes('json')) {
              report(entry.url, entry.method, this.status, contentType, entry.request);
              return;
            }
            const text = this.responseType === '' || this.responseType === 'text' ? this.responseText : '';
            if (!text || text.length > 512 * 1024) {
              report(entry.url, entry.method, this.status, contentType, entry.request);
              return;
            }
            const parsed = safeParse(text);
            const extra = analyzeResponse(parsed, text);
            report(
              entry.url,
              entry.method,
              this.status,
              contentType,
              entry.request,
              parsed === undefined ? undefined : shape(parsed),
              extra.enums,
              text.length,
            );
          } catch {
            /* ignore */
          }
        });
      }
      return send.apply(this, arguments as never);
    } as typeof OriginalXhr.prototype.send;
  }
})();
