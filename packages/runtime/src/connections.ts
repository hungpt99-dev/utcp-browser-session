/**
 * The websocket hub that owns the single connection to the browser extension.
 *
 * Handshake:
 *   1. runtime -> extension   { type: 'challenge', nonce }
 *   2. extension -> runtime   { type: 'hello', clientId, nonce, ts, signature }
 *      signature = ECDSA-P256-SHA256(privateKey, `${clientId}:${nonce}`)
 *   3. runtime verifies against the public key stored at pairing time.
 *
 * The nonce is generated per socket and consumed once, so a captured handshake
 * cannot be replayed. The runtime never holds a secret that could impersonate
 * the browser: only the public key.
 *
 * Concurrency: the browser is a shared, single-threaded resource, so calls are
 * bounded. Beyond `maxInFlight` they queue (bounded by `maxQueue`), and beyond
 * that the runtime answers `busy` instead of buffering without limit.
 */
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import {
  ErrorCode,
  ExtensionMessageSchema,
  LIMITS,
  ToolError,
  shapeDepth,
  type EndpointObservation,
  type ExecuteMessage,
  type ExtensionMessage,
  type ResultMessage,
} from '@utcp-browser-session/shared';
import type { Store } from './store.ts';
import type { Logger } from './logger.ts';

const EXTENSION_ORIGIN_RE = /^chrome-extension:\/\/([a-p]{32})$/;
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** Two missed heartbeats and the socket is considered dead. */
const PING_STALE_MS = 75_000;
const METRIC_WINDOW = 500;

interface Pending {
  resolve: (value: ResultMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  startedAt: number;
}

interface Queued {
  message: ExecuteMessage;
  resolve: (value: ResultMessage) => void;
  reject: (error: Error) => void;
  enqueuedAt: number;
}

export interface ActiveConnection {
  clientId: string;
  label: string;
  extensionId: string;
  connectedAt: string;
  capturing: Set<string>;
  lastMessageAt: number;
}

/** Bounded sample window with percentile helpers. */
class Samples {
  private readonly values: number[] = [];

  add(value: number): void {
    this.values.push(value);
    if (this.values.length > METRIC_WINDOW) this.values.shift();
  }

  summary(): { count: number; p50: number; p95: number; p99: number; max: number } {
    if (this.values.length === 0) return { count: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    const sorted = [...this.values].sort((a, b) => a - b);
    const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
    return {
      count: sorted.length,
      p50: Math.round(at(50) * 100) / 100,
      p95: Math.round(at(95) * 100) / 100,
      p99: Math.round(at(99) * 100) / 100,
      max: Math.round(sorted[sorted.length - 1] * 100) / 100,
    };
  }
}

export class ExtensionHub extends EventEmitter {
  private readonly wss: WebSocketServer;
  private readonly store: Store;
  private readonly logger: Logger;
  private connection: ActiveConnection | null = null;
  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly queue: Queued[] = [];
  private inFlight = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly browserLatency = new Samples();
  private readonly queueWait = new Samples();
  /** Counters used by the dashboard and by tests to prove data actually flowed. */
  readonly counters = {
    discoveryFrames: 0,
    observationsIngested: 0,
    observationsDropped: 0,
    resultsReceived: 0,
    callsQueued: 0,
    callsRejectedBusy: 0,
    cancellations: 0,
    sessionExpiredReports: 0,
  };

  constructor(store: Store, logger: Logger) {
    super();
    this.store = store;
    this.logger = logger;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxMessageBytes });
    this.heartbeat = setInterval(() => this.tick(), 25_000);
    this.heartbeat.unref?.();
  }

  get isConnected(): boolean {
    return this.connection !== null;
  }

  get activeConnection(): ActiveConnection | null {
    return this.connection;
  }

  /** Handle an HTTP upgrade; returns false when the path is not ours. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/extension') return false;

    const origin = request.headers.origin ?? '';
    const match = EXTENSION_ORIGIN_RE.exec(origin);
    if (!match) {
      this.logger.warn('extension.handshake.rejected', { reason: 'origin_not_allowed', origin: origin.slice(0, 80) });
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return true;
    }
    const extensionId = match[1];

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.onSocket(ws, extensionId, origin);
    });
    return true;
  }

  private onSocket(ws: WebSocket, extensionId: string, origin: string): void {
    const nonce = randomBytes(24).toString('base64url');
    let authenticated = false;

    const handshakeTimer = setTimeout(() => {
      if (!authenticated) {
        this.logger.warn('extension.handshake.timeout', { extensionId });
        ws.close(4401, 'handshake timeout');
      }
    }, HANDSHAKE_TIMEOUT_MS);

    ws.send(
      JSON.stringify({
        type: 'challenge',
        nonce,
        ts: Date.now(),
        runtime: 'utcp-browser-session',
      }),
    );

    ws.on('message', (data, isBinary) => {
      void (async () => {
        if (isBinary) {
          ws.close(4400, 'binary frames are not supported');
          return;
        }
        const raw = data.toString('utf8');
        if (raw.length > LIMITS.maxMessageBytes) {
          ws.close(4409, 'message too large');
          return;
        }
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(raw);
        } catch {
          ws.close(4400, 'invalid json');
          return;
        }
        const parsed = ExtensionMessageSchema.safeParse(parsedJson);
        if (!parsed.success) {
          this.logger.warn('extension.message.invalid', { issues: parsed.error.issues.slice(0, 3) });
          return;
        }
        const message = parsed.data;

        if (!authenticated) {
          if (message.type !== 'hello') {
            ws.close(4401, 'handshake required');
            return;
          }
          const verdict = await this.verifyHello(message, nonce, extensionId, origin);
          if (!verdict.ok) {
            this.logger.warn('extension.handshake.rejected', { reason: verdict.code });
            this.store.audit({
              kind: 'extension.handshake_rejected',
              severity: 'warn',
              actor: 'extension',
              message: `Rejected extension handshake: ${verdict.code}`,
            });
            ws.close(4401, 'unauthorized');
            return;
          }
          authenticated = true;
          clearTimeout(handshakeTimer);
          this.adopt(ws, verdict.clientId, verdict.label, extensionId);
          ws.send(JSON.stringify(this.syncFrame()));
          this.emit('connected', this.connection);
          return;
        }

        this.dispatch(message);
      })().catch((error: unknown) => {
        // A hostile frame (e.g. a shape nested 2000 deep) can make zod throw a
        // RangeError. That must close the socket, never take the runtime down.
        this.logger.warn('extension.message.failed', {
          message: error instanceof Error ? error.message : 'unknown',
        });
        try {
          ws.close(4400, 'bad message');
        } catch {
          /* already closed */
        }
      });
    });

    ws.on('close', () => {
      clearTimeout(handshakeTimer);
      if (this.socket === ws) this.dropConnection('socket_closed');
    });

    ws.on('error', (error: Error) => {
      this.logger.warn('extension.socket.error', { message: error.message });
    });
  }

  private async verifyHello(
    message: Extract<ExtensionMessage, { type: 'hello' }>,
    expectedNonce: string,
    extensionId: string,
    origin: string,
  ): Promise<{ ok: true; clientId: string; label: string } | { ok: false; code: string }> {
    if (message.nonce !== expectedNonce) return { ok: false, code: ErrorCode.REPLAY_DETECTED };
    if (Math.abs(Date.now() - message.ts) > LIMITS.handshakeSkewMs) return { ok: false, code: ErrorCode.REPLAY_DETECTED };

    const client = this.store.getClient(message.clientId);
    if (!client) return { ok: false, code: ErrorCode.PAIRING_REQUIRED };
    if (client.revokedAt) return { ok: false, code: ErrorCode.PAIRING_INVALID };
    if (client.extensionId !== extensionId) return { ok: false, code: ErrorCode.ORIGIN_NOT_ALLOWED };
    if (origin !== `chrome-extension://${extensionId}`) return { ok: false, code: ErrorCode.ORIGIN_NOT_ALLOWED };

    const data = new TextEncoder().encode(`${message.clientId}:${expectedNonce}`);
    let signature = new Uint8Array(0);
    try {
      const decoded = Buffer.from(message.signature, 'base64url');
      const copy = decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength) as ArrayBuffer;
      signature = new Uint8Array(copy);
    } catch {
      return { ok: false, code: ErrorCode.BAD_SIGNATURE };
    }

    try {
      const key = await crypto.subtle.importKey(
        'jwk',
        { ...client.publicKeyJwk, ext: true },
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      );
      const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, data);
      if (!valid) return { ok: false, code: ErrorCode.BAD_SIGNATURE };
    } catch (error) {
      this.logger.warn('extension.verify.error', { message: error instanceof Error ? error.message : 'unknown' });
      return { ok: false, code: ErrorCode.BAD_SIGNATURE };
    }

    return { ok: true, clientId: client.clientId, label: client.label };
  }

  private adopt(ws: WebSocket, clientId: string, label: string, extensionId: string): void {
    // Calls in flight on the socket being replaced will never be answered by it;
    // reject them now instead of letting them wait out their timeouts.
    if (this.socket && this.socket !== ws) {
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new ToolError(ErrorCode.EXTENSION_DISCONNECTED, 'The browser connection was replaced by a newer one.'));
        this.pending.delete(id);
      }
    }
    if (this.socket && this.socket !== ws) {
      try {
        this.socket.close(4409, 'replaced by a newer connection');
      } catch {
        /* ignore */
      }
    }
    this.socket = ws;
    this.connection = {
      clientId,
      label,
      extensionId,
      connectedAt: new Date().toISOString(),
      capturing: new Set(this.store.listDomains().filter((domain) => domain.enabled && domain.deepCapture).map((domain) => domain.origin)),
      lastMessageAt: Date.now(),
    };
    this.store.touchClient(clientId);
    this.store.audit({
      kind: 'extension.connected',
      severity: 'info',
      actor: 'extension',
      message: `Browser extension "${label}" connected.`,
    });
    this.logger.info('extension.connected', { clientId, label });
  }

  private dropConnection(reason: string): void {
    const previous = this.connection;
    this.connection = null;
    this.socket = null;
    this.inFlight = 0;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new ToolError(ErrorCode.EXTENSION_DISCONNECTED, 'The browser extension disconnected before answering.'));
      this.pending.delete(id);
    }
    while (this.queue.length > 0) {
      const queued = this.queue.shift()!;
      queued.reject(new ToolError(ErrorCode.EXTENSION_DISCONNECTED, 'The browser extension disconnected while this call was queued.'));
    }
    if (previous) {
      this.store.audit({
        kind: 'extension.disconnected',
        severity: 'warn',
        actor: 'extension',
        message: `Browser extension disconnected (${reason}).`,
      });
      this.logger.info('extension.disconnected', { reason });
      this.emit('disconnected', previous);
    }
  }

  private dispatch(message: ExtensionMessage): void {
    if (this.connection) this.connection.lastMessageAt = Date.now();
    switch (message.type) {
      case 'result': {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        this.counters.resultsReceived += 1;
        this.browserLatency.add(message.latencyMs);
        pending.resolve(message);
        return;
      }
      case 'discovery': {
        this.ingestDiscovery(message.events);
        return;
      }
      case 'status': {
        if (this.connection) this.connection.capturing = new Set(message.capturing);
        return;
      }
      case 'session': {
        this.onSession(message);
        return;
      }
      case 'intent': {
        this.onIntent(message);
        return;
      }
      case 'pong':
        return;
      default:
        return;
    }
  }

  private onSession(message: Extract<ExtensionMessage, { type: 'session' }>): void {
    this.store.setSession(message.origin, message.status, message.httpStatus, message.status === 'expired' ? ErrorCode.WEBSITE_AUTH_EXPIRED : null);
    if (message.status === 'expired' && this.store.getDomain(message.origin)?.enabled) {
      this.counters.sessionExpiredReports += 1;
      this.store.audit({
        kind: 'session.expired',
        severity: 'warn',
        actor: 'extension',
        origin: message.origin,
        message: `The extension observed HTTP ${message.httpStatus} for ${message.origin}; the session looks expired.`,
      });
      this.logger.warn('session.expired', { origin: message.origin, httpStatus: message.httpStatus });
    }
  }

  /**
   * Actions the human took in the extension popup. The popup never holds the
   * runtime token, so it asks its own authenticated socket instead. Only the
   * paired browser can reach this path, and every action is audited.
   */
  private onIntent(message: Extract<ExtensionMessage, { type: 'intent' }>): void {
    let parsed: URL;
    try {
      parsed = new URL(message.origin);
    } catch {
      this.logger.warn('intent.rejected', { reason: 'invalid_origin' });
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;

    const origin = parsed.origin;
    switch (message.action) {
      case 'enable_origin': {
        this.store.enableDomain(origin, parsed.hostname, { deepCapture: message.deepCapture ?? false });
        this.store.audit({
          kind: 'domain.enabled',
          severity: 'info',
          actor: 'extension',
          origin,
          message: `Enabled ${origin} from the extension popup.`,
        });
        this.sync();
        return;
      }
      case 'disable_origin': {
        this.store.disableDomain(origin);
        this.store.audit({
          kind: 'domain.disabled',
          severity: 'warn',
          actor: 'extension',
          origin,
          message: `Disabled ${origin} and revoked its tools from the extension popup.`,
        });
        this.sync();
        return;
      }
      case 'discovery_start': {
        if (!this.store.isDomainEnabled(origin)) {
          this.logger.warn('intent.rejected', { reason: 'origin_not_enabled', origin });
          return;
        }
        this.startDiscovery(origin, parsed.hostname, message.deepCapture ?? false);
        return;
      }
      case 'discovery_stop': {
        this.stopDiscovery(origin);
        return;
      }
      default:
        return;
    }
  }

  private ingestDiscovery(events: EndpointObservation[]): void {
    this.counters.discoveryFrames += 1;
    const byOrigin = new Map<string, EndpointObservation[]>();
    for (const event of events) {
      // Depth is bounded before anything is stored or stringified further.
      if (shapeDepth(event.requestShape) > LIMITS.maxSchemaDepth || shapeDepth(event.responseShape) > LIMITS.maxSchemaDepth) {
        this.counters.observationsDropped += 1;
        continue;
      }
      const capturing = this.connection?.capturing.has(event.origin) ?? false;
      if (!capturing || !this.store.isDomainEnabled(event.origin)) {
        this.counters.observationsDropped += 1;
        continue;
      }
      const bucket = byOrigin.get(event.origin) ?? [];
      bucket.push(event);
      byOrigin.set(event.origin, bucket);
    }
    for (const bucket of byOrigin.values()) {
      const ingested = this.store.recordObservations(bucket);
      this.counters.observationsIngested += ingested;
    }
  }

  /** Send an execute frame and await its correlated result. */
  async execute(message: ExecuteMessage): Promise<ResultMessage> {
    if (!this.socket || !this.connection) {
      throw new ToolError(ErrorCode.NO_BROWSER, 'No browser is connected to the runtime.', {
        hint: 'Open Chrome with the extension installed, then pair or reconnect it.',
      });
    }
    const maxInFlight = this.store.settings.maxInFlight;
    if (this.inFlight < maxInFlight) return this.send(message);

    if (this.queue.length >= this.store.settings.maxQueue) {
      this.counters.callsRejectedBusy += 1;
      throw new ToolError(ErrorCode.BUSY, 'The browser is at capacity; this call was rejected instead of queued.', {
        hint: 'Retry shortly, or raise maxQueue in settings.',
        details: { inFlight: this.inFlight, queued: this.queue.length },
      });
    }

    this.counters.callsQueued += 1;
    return new Promise<ResultMessage>((resolve, reject) => {
      this.queue.push({ message, resolve, reject, enqueuedAt: Date.now() });
    });
  }

  private async send(message: ExecuteMessage): Promise<ResultMessage> {
    this.inFlight += 1;
    try {
      return await this.sendNow(message);
    } finally {
      this.inFlight -= 1;
      this.drain();
    }
  }

  private drain(): void {
    const maxInFlight = this.store.settings.maxInFlight;
    while (this.inFlight < maxInFlight && this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.queueWait.add(Date.now() - next.enqueuedAt);
      void this.send(next.message).then(next.resolve, next.reject);
    }
  }

  private async sendNow(message: ExecuteMessage): Promise<ResultMessage> {
    const socket = this.socket;
    if (!socket) {
      throw new ToolError(ErrorCode.NO_BROWSER, 'No browser is connected to the runtime.');
    }
    const id = message.id;
    return new Promise<ResultMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ToolError(ErrorCode.TIMEOUT, `The website did not answer within ${message.timeoutMs} ms.`));
      }, message.timeoutMs + 1500);

      this.pending.set(id, { resolve, reject, timer, startedAt: Date.now() });
      try {
        socket.send(JSON.stringify({ ...message, id }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          new ToolError(ErrorCode.EXTENSION_DISCONNECTED, 'Could not reach the browser extension.', {
            details: { message: error instanceof Error ? error.message : 'unknown' },
          }),
        );
      }
    });
  }

  /**
   * Cancel an in-flight call. The browser aborts the fetch; the caller gets an
   * `aborted` error immediately and no result is awaited.
   */
  cancel(id: string, reason = 'client_cancelled'): boolean {
    const pending = this.pending.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      this.counters.cancellations += 1;
      try {
        this.socket?.send(JSON.stringify({ type: 'cancel', id, reason }));
      } catch {
        /* the socket is already gone */
      }
      pending.reject(new ToolError(ErrorCode.ABORTED, 'The call was cancelled before the website answered.'));
      return true;
    }
    const index = this.queue.findIndex((queued) => queued.message.id === id);
    if (index >= 0) {
      const [queued] = this.queue.splice(index, 1);
      this.counters.cancellations += 1;
      queued.reject(new ToolError(ErrorCode.ABORTED, 'The call was cancelled while queued.'));
      return true;
    }
    return false;
  }

  private syncFrame(): {
    type: 'sync';
    enabledOrigins: string[];
    deepCaptureOrigins: string[];
    enumCaptureOrigins: string[];
    capturing: string[];
  } {
    return {
      type: 'sync',
      enabledOrigins: this.store.enabledOrigins(),
      deepCaptureOrigins: this.store.deepCaptureOrigins(),
      enumCaptureOrigins: this.store.enumCaptureOrigins(),
      capturing: [...(this.connection?.capturing ?? [])],
    };
  }

  /** Push the current origin allowlist to the extension. */
  sync(): void {
    if (!this.socket || !this.connection) return;
    this.socket.send(JSON.stringify(this.syncFrame()));
  }

  startDiscovery(origin: string, domain: string, deepCapture: boolean, captureEnums = false): void {
    if (!this.socket) throw new ToolError(ErrorCode.NO_BROWSER, 'No browser is connected.');
    this.connection?.capturing.add(origin);
    this.socket.send(JSON.stringify({ type: 'discovery_start', origin, domain, deepCapture, captureEnums }));
  }

  stopDiscovery(origin: string): void {
    if (this.socket) this.socket.send(JSON.stringify({ type: 'discovery_stop', origin }));
    this.connection?.capturing.delete(origin);
  }

  /** Close the live socket for a client that was just revoked. */
  disconnectClient(clientId: string, reason = 'client_revoked'): boolean {
    if (this.connection?.clientId !== clientId) return false;
    const socket = this.socket;
    this.dropConnection(reason);
    try {
      socket?.close(4003, reason);
    } catch {
      /* already gone */
    }
    this.store.audit({
      kind: 'extension.revoked_live',
      severity: 'warn',
      actor: 'runtime',
      message: `Disconnected ${clientId} because its pairing was revoked.`,
    });
    return true;
  }

  private tick(): void {
    if (!this.socket) return;
    // A half-open socket (blackholed TCP) never fires close/error; without this
    // the dashboard would show a connected browser that cannot answer.
    const lastSeen = this.connection?.lastMessageAt ?? 0;
    if (lastSeen > 0 && Date.now() - lastSeen > PING_STALE_MS) {
      this.logger.warn('extension.socket.stale', { silentMs: Date.now() - lastSeen });
      try {
        this.socket.terminate();
      } catch {
        /* already gone */
      }
      this.dropConnection('socket_stale');
      return;
    }
    if (this.socket.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
      } catch {
        /* close handler will clean up */
      }
    }
  }

  metrics() {
    return {
      browserLatencyMs: this.browserLatency.summary(),
      queueWaitMs: this.queueWait.summary(),
      inFlight: this.inFlight,
      queued: this.queue.length,
      counters: { ...this.counters },
    };
  }

  status() {
    if (!this.connection) return { connected: false, client: null, capturing: [] as string[], counters: { ...this.counters } };
    return {
      connected: true,
      client: {
        clientId: this.connection.clientId,
        label: this.connection.label,
        connectedAt: this.connection.connectedAt,
      },
      capturing: [...this.connection.capturing],
      counters: { ...this.counters },
    };
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.dropConnection('runtime_shutdown');
    for (const client of this.wss.clients) {
      try {
        client.close(1001, 'runtime_shutdown');
        client.terminate();
      } catch {
        /* already gone */
      }
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}
