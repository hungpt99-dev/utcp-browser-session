/**
 * Discovery collection inside the service worker.
 *
 * Two independent sources feed the same inventory:
 *
 *   1. `webRequest` (always on) — method, path, query names, content type,
 *      status. MV3 does not expose request or response bodies here.
 *   2. The page tap (only where the user enabled schema capture) — structural
 *      JSON shapes, never values.
 *
 * Requests originated by the extension itself are ignored (tabId === -1 and an
 * extension initiator), so tool execution never pollutes discovery.
 */
import { normalizeDomain, type EndpointObservation, type ShapeNode } from '@utcp-browser-session/shared';

const SKIP_TYPES = new Set([
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'media',
  'websocket',
  'csp_report',
  'ping',
]);

interface Pending {
  method: string;
  path: string;
  queryKeys: string[];
  domain: string;
  at: number;
}

export interface TapEvent {
  kind: string;
  url: string;
  method: string;
  status: number;
  contentType: string;
  requestShape?: ShapeNode | null;
  responseShape?: ShapeNode | null;
}

export class DiscoveryCollector {
  private readonly pending = new Map<string, Pending>();
  private readonly buffer: EndpointObservation[] = [];
  private readonly seen = new Map<string, number>();
  private readonly capturing: () => Set<string>;
  private readonly deepCapture: () => Set<string>;
  /** Diagnostics for the inspector and tests: why the last tap was ignored. */
  readonly drops = { badUrl: 0, notCapturing: 0, notDeep: 0, accepted: 0, lastDrop: '' };

  constructor(capturing: () => Set<string>, deepCapture: () => Set<string>) {
    this.capturing = capturing;
    this.deepCapture = deepCapture;
  }

  onBeforeRequest(details: chrome.webRequest.OnBeforeRequestDetails): void {
    if (SKIP_TYPES.has(details.type)) return;
    if (details.tabId < 0) return;
    if ((details.initiator ?? '').startsWith('chrome-extension://')) return;
    if (!details.url.startsWith('http')) return;

    let url: URL;
    try {
      url = new URL(details.url);
    } catch {
      return;
    }
    const domain = normalizeDomain(url.hostname);
    if (!this.capturing().has(domain)) return;

    this.pending.set(details.requestId, {
      method: details.method.toUpperCase(),
      path: url.pathname,
      queryKeys: [...url.searchParams.keys()],
      domain,
      at: Date.now(),
    });
    if (this.pending.size > 300) {
      const oldest = [...this.pending.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100);
      for (const [key] of oldest) this.pending.delete(key);
    }
  }

  onCompleted(details: chrome.webRequest.OnCompletedDetails): void {
    const entry = this.pending.get(details.requestId);
    if (!entry) return;
    this.pending.delete(details.requestId);
    if (details.tabId < 0) return;

    const contentType = (details.responseHeaders ?? []).find((header) => header.name.toLowerCase() === 'content-type')?.value;
    this.push({
      domain: entry.domain,
      method: entry.method,
      path: entry.path,
      queryKeys: entry.queryKeys,
      status: details.statusCode,
      ...(contentType ? { contentType: contentType.split(';')[0] } : {}),
      source: 'webRequest',
    });
  }

  onTap(event: TapEvent): void {
    if (!event || typeof event.url !== 'string') {
      this.drops.badUrl += 1;
      this.drops.lastDrop = 'bad_payload';
      return;
    }
    let url: URL;
    try {
      url = new URL(event.url, 'http://127.0.0.1');
    } catch {
      this.drops.badUrl += 1;
      this.drops.lastDrop = 'unparseable_url';
      return;
    }
    const domain = normalizeDomain(url.hostname);
    if (!this.capturing().has(domain)) {
      this.drops.notCapturing += 1;
      this.drops.lastDrop = `not_capturing:${domain}`;
      return;
    }
    if (!this.deepCapture().has(domain)) {
      this.drops.notDeep += 1;
      this.drops.lastDrop = `not_deep:${domain}`;
      return;
    }

    const observation: EndpointObservation = {
      domain,
      method: String(event.method || 'GET').toUpperCase(),
      path: url.pathname,
      queryKeys: [...url.searchParams.keys()],
      source: 'page-tap',
    };
    if (typeof event.status === 'number' && event.status >= 100) observation.status = event.status;
    if (event.contentType) observation.contentType = String(event.contentType).split(';')[0].slice(0, 120);
    if (event.requestShape) observation.requestShape = event.requestShape;
    if (event.responseShape) observation.responseShape = event.responseShape;
    this.drops.accepted += 1;
    this.push(observation);
  }

  private push(observation: EndpointObservation): void {
    // Dedupe per source: `webRequest` and `page-tap` describe the same request
    // but carry different data, and the runtime merges them by endpoint key.
    const key = `${observation.source} ${observation.method} ${observation.path}`;
    const last = this.seen.get(key) ?? 0;
    const now = Date.now();
    if (now - last < 400) return;
    this.seen.set(key, now);
    this.buffer.push(observation);
    if (this.buffer.length > 200) this.buffer.splice(0, this.buffer.length - 200);
  }

  drain(): EndpointObservation[] {
    const events = this.buffer.splice(0, 40);
    return events;
  }

  get size(): number {
    return this.buffer.length;
  }
}
