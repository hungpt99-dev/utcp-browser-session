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
  type EndpointObservation,
  type ExecuteMessage,
  type ResultMessage,
} from '@utcp-browser-session/shared';
import type { Store } from './store.ts';
import type { Logger } from './logger.ts';

const EXTENSION_ORIGIN_RE = /^chrome-extension:\/\/([a-p]{32})$/;
const HANDSHAKE_TIMEOUT_MS = 10_000;

interface Pending {
  resolve: (value: ResultMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  startedAt: number;
}

export interface ActiveConnection {
  clientId: string;
  label: string;
  extensionId: string;
  connectedAt: string;
  capturing: Set<string>;
  lastMessageAt: number;
}

export class ExtensionHub extends EventEmitter {
  private readonly wss: WebSocketServer;
  private readonly store: Store;
  private readonly logger: Logger;
  private connection: ActiveConnection | null = null;
  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, Pending>();
  private heartbeat: NodeJS.Timeout | null = null;
  /** Counters used by the dashboard and by tests to prove data actually flowed. */
  readonly counters = { discoveryFrames: 0, observationsIngested: 0, observationsDropped: 0, resultsReceived: 0 };

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
              domain: null,
              toolName: null,
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
      })();
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
    message: Extract<import('@utcp-browser-session/shared').ExtensionMessage, { type: 'hello' }>,
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
      capturing: new Set(),
      lastMessageAt: Date.now(),
    };
    this.store.touchClient(clientId);
    this.store.audit({
      kind: 'extension.connected',
      severity: 'info',
      actor: 'extension',
      domain: null,
      toolName: null,
      message: `Browser extension "${label}" connected.`,
    });
    this.logger.info('extension.connected', { clientId, label });
  }

  private dropConnection(reason: string): void {
    const previous = this.connection;
    this.connection = null;
    this.socket = null;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new ToolError(ErrorCode.EXTENSION_DISCONNECTED, 'The browser extension disconnected before answering.'));
      this.pending.delete(id);
    }
    if (previous) {
      this.store.audit({
        kind: 'extension.disconnected',
        severity: 'warn',
        actor: 'extension',
        domain: null,
        toolName: null,
        message: `Browser extension disconnected (${reason}).`,
      });
      this.logger.info('extension.disconnected', { reason });
      this.emit('disconnected', previous);
    }
  }

  private dispatch(message: import('@utcp-browser-session/shared').ExtensionMessage): void {
    if (this.connection) this.connection.lastMessageAt = Date.now();
    switch (message.type) {
      case 'result': {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
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
      case 'pong':
        return;
      default:
        return;
    }
  }

  private ingestDiscovery(events: EndpointObservation[]): void {
    this.counters.discoveryFrames += 1;
    for (const event of events) {
      if (!this.store.isDomainEnabled(event.domain)) {
        this.counters.observationsDropped += 1;
        continue;
      }
      if (this.connection && !this.connection.capturing.has(event.domain)) {
        this.counters.observationsDropped += 1;
        continue;
      }
      this.store.recordObservation(event);
      this.counters.observationsIngested += 1;
    }
  }

  /** Send an execute frame and await its correlated result. */
  async execute(message: ExecuteMessage): Promise<ResultMessage> {
    if (!this.socket || !this.connection) {
      throw new ToolError(ErrorCode.EXTENSION_DISCONNECTED, 'No browser is connected to the runtime.', {
        hint: 'Open Chrome with the extension installed, then pair or reconnect it.',
      });
    }
    const id = message.id;
    return new Promise<ResultMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ToolError(ErrorCode.TIMEOUT, `The website did not answer within ${message.timeoutMs} ms.`));
      }, message.timeoutMs + 1500);

      this.pending.set(id, { resolve, reject, timer, startedAt: Date.now() });
      try {
        this.socket!.send(JSON.stringify({ ...message, id }));
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

  private syncFrame(): { type: 'sync'; enabledDomains: string[]; deepCapture: string[] } {
    const domains = this.store.listDomains().filter((domain) => domain.enabled);
    return {
      type: 'sync',
      enabledDomains: domains.map((domain) => domain.domain),
      deepCapture: domains.filter((domain) => domain.deepCapture).map((domain) => domain.domain),
    };
  }

  /** Push the current domain allowlist to the extension. */
  sync(): void {
    if (!this.socket || !this.connection) return;
    this.socket.send(JSON.stringify(this.syncFrame()));
  }

  startDiscovery(domain: string, deepCapture: boolean): void {
    if (!this.socket) throw new ToolError(ErrorCode.EXTENSION_DISCONNECTED, 'No browser is connected.');
    this.connection?.capturing.add(domain);
    this.socket.send(JSON.stringify({ type: 'discovery_start', domain, deepCapture }));
  }

  stopDiscovery(domain: string): void {
    if (this.socket) {
      this.socket.send(JSON.stringify({ type: 'discovery_stop', domain }));
    }
    this.connection?.capturing.delete(domain);
  }

  private tick(): void {
    if (!this.socket) return;
    if (this.socket.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
      } catch {
        /* close handler will clean up */
      }
    }
  }

  status(): {
    connected: boolean;
    client: { clientId: string; label: string; connectedAt: string } | null;
    capturing: string[];
    counters: { discoveryFrames: number; observationsIngested: number; observationsDropped: number; resultsReceived: number };
  } {
    if (!this.connection) return { connected: false, client: null, capturing: [], counters: { ...this.counters } };
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
