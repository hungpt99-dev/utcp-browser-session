/**
 * Page-context schema tap (MAIN world).
 *
 * MV3's `webRequest` cannot see request or response bodies, so structural
 * inference happens here instead. This code:
 *
 *   - never reads cookie or authorization headers,
 *   - never records values, only JSON *types* (plus `format: date-time`),
 *   - caps depth and property count,
 *   - is a no-op if anything about the page looks unexpected.
 *
 * The isolated-world bridge relays these messages to the service worker, which
 * drops them unless the user enabled schema capture for that domain.
 */
(() => {
  const TAG = '__utcp_tap__';
  const MAX_DEPTH = 5;
  const MAX_PROPS = 40;

  if ((window as unknown as Record<string, unknown>)[TAG]) return;
  (window as unknown as Record<string, unknown>)[TAG] = true;

  const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

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

  function describeRequest(body: unknown): Record<string, unknown> | undefined {
    if (!isJsonRequest(body)) return undefined;
    const parsed = safeParse(body);
    return parsed === undefined ? undefined : shape(parsed);
  }

  function report(
    url: string,
    method: string,
    status: number,
    contentType: string,
    requestShape?: Record<string, unknown>,
    responseShape?: Record<string, unknown>,
  ): void {
    emit({
      kind: 'http',
      url,
      method,
      status,
      contentType,
      requestShape: requestShape ?? null,
      responseShape: responseShape ?? null,
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

      const requestShape = describeRequest(request.body ?? (input instanceof Request ? undefined : undefined));

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
                  report(url, method, response.status, contentType, requestShape, undefined);
                  return;
                }
                const parsed = safeParse(text);
                report(url, method, response.status, contentType, requestShape, parsed === undefined ? undefined : shape(parsed));
              })
              .catch(() => undefined);
          } else {
            report(url, method, response.status, contentType, requestShape, undefined);
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
    const state = new WeakMap<XMLHttpRequest, { url: string; method: string; requestShape?: Record<string, unknown> }>();

    OriginalXhr.prototype.open = function patchedOpen(this: XMLHttpRequest, method: string, url: string | URL) {
      try {
        const absolute = new URL(String(url), location.href).toString();
        state.set(this, { url: absolute, method: String(method || 'GET').toUpperCase() });
      } catch {
        /* ignore */
      }
      return open.apply(this, arguments as never);
    } as typeof OriginalXhr.prototype.open;

    OriginalXhr.prototype.send = function patchedSend(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      const entry = state.get(this);
      if (entry) {
        entry.requestShape = describeRequest(body);
        this.addEventListener('loadend', () => {
          try {
            const contentType = this.getResponseHeader('content-type') ?? '';
            if (!contentType.includes('json')) {
              report(entry.url, entry.method, this.status, contentType, entry.requestShape, undefined);
              return;
            }
            const text = this.responseType === '' || this.responseType === 'text' ? this.responseText : '';
            if (!text || text.length > 512 * 1024) {
              report(entry.url, entry.method, this.status, contentType, entry.requestShape, undefined);
              return;
            }
            const parsed = safeParse(text);
            report(entry.url, entry.method, this.status, contentType, entry.requestShape, parsed === undefined ? undefined : shape(parsed));
          } catch {
            /* ignore */
          }
        });
      }
      return send.apply(this, arguments as never);
    } as typeof OriginalXhr.prototype.send;
  }
})();
