/**
 * A protocol-accurate stand-in for the Chrome extension.
 *
 * It performs the same ECDSA handshake over the same websocket, and lets a test
 * script the website's answer. That makes the runtime's dispatch, timeout,
 * disconnect and redirect paths testable without a browser.
 */
import { WebSocket } from 'ws';
import { createHash } from 'node:crypto';

interface ExecuteFrame {
  type: 'execute';
  id: string;
  method: string;
  url: string;
  origin: string;
  correlationId?: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  csrf?: { bootstrapPath: string; tokenField: string; header: string };
}

export interface SyncFrame {
  type: 'sync';
  enabledOrigins: string[];
  deepCaptureOrigins: string[];
  enumCaptureOrigins: string[];
}

export type ExecuteHandler = (frame: ExecuteFrame) => Promise<Record<string, unknown>> | Record<string, unknown>;

export interface FakeExtensionOptions {
  runtimeUrl: string;
  token: string;
  label?: string;
}

/** Deliberate protocol violations used by the security tests. */
export interface Tamper {
  signature?: string;
  ts?: number;
  nonce?: string;
  origin?: string;
  skipHello?: boolean;
}

export class FakeExtension {
  private static readonly keyPair = new WeakMap<FakeExtension, { publicJwk: JsonWebKey; privateKey: CryptoKey }>();

  clientId = '';
  socket: WebSocket | null = null;
  readonly received: ExecuteFrame[] = [];
  readonly syncFrames: SyncFrame[] = [];
  readonly discoverySent: unknown[] = [];
  private handler: ExecuteHandler = () => ({
    type: 'result',
    id: '',
    ok: true,
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: '{"ok":true}',
    latencyMs: 3,
    truncated: false,
    bodyEncoding: 'utf8',
  });
  private readonly options: FakeExtensionOptions;
  private synced: Promise<void>;
  private markSynced!: () => void;

  constructor(options: FakeExtensionOptions) {
    this.options = options;
    this.synced = new Promise<void>((resolve) => {
      this.markSynced = resolve;
    });
  }

  static async pair(options: FakeExtensionOptions): Promise<FakeExtension> {
    const instance = new FakeExtension(options);
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    FakeExtension.keyPair.set(instance, { publicJwk, privateKey: pair.privateKey });

    const startResponse = await fetch(`${options.runtimeUrl}/api/v1/pair/start`, {
      method: 'POST',
      headers: { authorization: `Bearer ${options.token}` },
    });
    const { code } = (await startResponse.json()) as { code: string };

    // A fixed, valid extension id keeps the Origin header realistic.
    const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
    const claim = await fetch(`${options.runtimeUrl}/api/v1/pair/claim`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: `chrome-extension://${extensionId}`,
      },
      body: JSON.stringify({
        code,
        extensionId,
        label: options.label ?? 'fake extension',
        publicKeyJwk: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y },
      }),
    });
    if (!claim.ok) throw new Error(`claim failed: ${claim.status} ${await claim.text()}`);
    const { clientId } = (await claim.json()) as { clientId: string };
    instance.clientId = clientId;
    instance.extensionId = extensionId;
    return instance;
  }

  extensionId = 'abcdefghijklmnopabcdefghijklmnop';
  tamper: Tamper = {};

  onExecute(handler: ExecuteHandler): void {
    this.handler = handler;
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const origin = this.tamper.origin ?? `chrome-extension://${this.extensionId}`;
      const socket = new WebSocket(`${this.options.runtimeUrl.replace('http', 'ws')}/extension`, { origin });
      this.socket = socket;
      socket.on('error', (error: Error) => reject(error));
      socket.on('close', () => reject(new Error('socket closed during handshake')));
      socket.on('message', (data: Buffer) => {
        const frame = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
        void this.onFrame(frame, resolve);
      });
      setTimeout(() => reject(new Error('handshake timed out')), 5000);
    }).catch((error: Error) => {
      // A rejected handshake surfaces as a closed socket; callers that expect
      // rejection can inspect this instead of crashing.
      if (!this.expectRejection) throw error;
    });
  }

  /** When true, a failed handshake resolves instead of throwing. */
  expectRejection = false;

  private async onFrame(frame: Record<string, unknown>, connected: () => void): Promise<void> {
    if (frame.type === 'challenge') {
      if (this.tamper.skipHello) return;
      const privateKey = FakeExtension.keyPair.get(this)!.privateKey;
      const data = new TextEncoder().encode(`${this.clientId}:${String(frame.nonce)}`);
      const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data);
      this.send({
        type: 'hello',
        clientId: this.clientId,
        nonce: this.tamper.nonce ?? frame.nonce,
        ts: this.tamper.ts ?? Date.now(),
        signature: this.tamper.signature ?? Buffer.from(signature).toString('base64url'),
        agent: 'fake-extension',
      });
      return;
    }
    if (frame.type === 'sync') {
      this.syncFrames.push(frame as unknown as SyncFrame);
      this.markSynced();
      connected();
      return;
    }
    if (frame.type === 'ping') {
      this.send({ type: 'pong', ts: Date.now() });
      return;
    }
    if (frame.type === 'execute') {
      const execute = frame as unknown as ExecuteFrame;
      this.received.push(execute);
      const answer = await this.handler(execute);
      this.send({ ...answer, type: 'result', id: execute.id });
      return;
    }
  }

  async waitForSync(): Promise<void> {
    await this.synced;
  }

  /** Most recent allowlist pushed by the runtime. */
  lastSyncFrame(): SyncFrame | undefined {
    return this.syncFrames.at(-1);
  }

  send(frame: Record<string, unknown>): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
  }

  sendDiscovery(events: unknown[]): void {
    this.discoverySent.push(events);
    this.send({ type: 'discovery', events });
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}

export function signatureHash(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
