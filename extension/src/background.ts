/**
 * Extension service worker.
 *
 * Responsibilities:
 *   - pair with the local runtime (one-time code, ECDSA key pair),
 *   - hold the authenticated websocket and reconnect with backoff,
 *   - execute approved requests with the browser's own session cookies,
 *   - observe API traffic for user-controlled discovery,
 *   - never read, store or forward a website credential.
 *
 * Credential boundary: `fetch(..., { credentials: 'include' })` makes Chrome
 * attach the site's HttpOnly cookies at the network layer. Extension JavaScript
 * never sees those values, and the runtime never receives them.
 */
import {
  ErrorCode,
  ExecuteMessageSchema,
  LIMITS,
  checkTargetUrl,
  type ExecuteMessage,
  type ResultMessage,
} from '@utcp-browser-session/shared';
import { DiscoveryCollector, type TapEvent } from './lib/discovery.ts';
import { generateKeyPair, signChallenge } from './lib/crypto.ts';
import { clearPairing, getState, isPaired, setState, type ExtensionState } from './lib/state.ts';

/**
 * A result travels in a single websocket frame, and the runtime closes the
 * socket when a frame exceeds `maxMessageBytes`. Capping the body at the frame
 * limit (minus room for headers and JSON escaping) keeps a large response from
 * looking like a protocol violation.
 */
const MAX_RESPONSE_BYTES = Math.min(LIMITS.maxResponseBytes, LIMITS.maxMessageBytes - 32 * 1024);
const MAX_CSRF_BYTES = 64 * 1024;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const ALARM_NAME = 'ubs:reconnect';

let socket: WebSocket | null = null;
let connected = false;
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let webRequestFilters: string[] = [];
let listenersAttached = false;

let cache: ExtensionState | null = null;
let tapMessages = 0;
let tapAccepted = 0;
const syncLog: string[] = [];
let lastExecute: { url: string; error?: string; status?: number } | null = null;
/** Simple per-worker budget for page-originated tap messages. */
let tapBudget = 0;
let lastTapAt = 0;

async function state(): Promise<ExtensionState> {
  cache = await getState();
  return cache;
}

const capturing = () => new Set(cache?.capturing ?? []);
const deepCapture = () => new Set(cache?.deepCaptureOrigins ?? []);
const enumCapture = () => new Set(cache?.enumCaptureOrigins ?? []);
const collector = new DiscoveryCollector(capturing, deepCapture, enumCapture);

/** In-flight browser requests, so a `cancel` frame can abort the right fetch. */
const inflight = new Map<string, AbortController>();
const cancelled = new Set<string>();
/** Last session state reported per origin, to avoid spamming the runtime. */
const sessionState = new Map<string, 'ok' | 'expired'>();

/**
 * Minimal introspection surface used by the E2E tests and by `chrome://extensions`
 * inspection. It exposes counts only, never payloads.
 */
(self as unknown as Record<string, unknown>).__ubsDebug = async () => ({
  connected,
  capturing: [...capturing()],
  deepCapture: [...deepCapture()],
  buffered: collector.size,
  enabledOrigins: cache?.enabledOrigins ?? [],
  tapMessages,
  tapAccepted,
  drops: { ...collector.drops },
  lastExecute,
  syncLog: syncLog.slice(-5),
  stored: (await getState()).enabledOrigins,
});

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

async function refreshBadge(): Promise<void> {
  const current = await state();
  if (!isPaired(current)) {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  await chrome.action.setBadgeBackgroundColor({ color: connected ? '#16a34a' : '#b45309' });
  await chrome.action.setBadgeText({ text: connected ? 'on' : '!' });
}

// ---------------------------------------------------------------------------
// Websocket lifecycle
// ---------------------------------------------------------------------------

/** True once the runtime has answered `hello` with `sync`. */
let ready = false;
/** Outbound frames held until the handshake completes. */
const outbox: string[] = [];

function send(frame: Record<string, unknown>): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  const type = String(frame.type ?? '');
  if (!ready && type !== 'hello' && type !== 'pong') {
    // Never race the handshake: the runtime closes the socket on a pre-auth frame.
    if (outbox.length < 50) outbox.push(JSON.stringify(frame));
    return false;
  }
  let text = JSON.stringify(frame);
  if (text.length > LIMITS.maxMessageBytes) {
    if (type === 'result') {
      frame.body = '';
      frame.truncated = true;
      delete frame.redirectedTo;
      text = JSON.stringify(frame);
    }
    if (text.length > LIMITS.maxMessageBytes) return false;
  }
  try {
    socket.send(text);
    return true;
  } catch {
    return false;
  }
}

function flushOutbox(): void {
  while (ready && outbox.length > 0) {
    const text = outbox.shift()!;
    try {
      socket?.send(text);
    } catch {
      /* the socket is gone; the reconnect path will retry the flush */
      return;
    }
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

async function connect(): Promise<void> {
  const current = await state();
  if (!isPaired(current) || socket) return;

  const wsUrl = current.runtimeUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/extension';
  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl);
  } catch {
    await setState({ lastError: 'Invalid runtime URL.' });
    scheduleReconnect();
    return;
  }
  socket = ws;

  let failed = false;
  const fail = async (message: string) => {
    // A close/error from a socket that was already replaced must not clobber the
    // live one's state (that made the popup show "Offline" while calls worked).
    if (socket !== ws) return;
    if (failed) return;
    failed = true;
    socket = null;
    connected = false;
    ready = false;
    outbox.length = 0;
    await setState({ lastError: message });
    await refreshBadge();
    scheduleReconnect();
  };

  ws.addEventListener('message', (event) => {
    void handleFrame(String(event.data)).catch(async (error: unknown) => {
      // A malformed or hostile frame must never become an unhandled rejection.
      await setState({ lastError: `Ignored a bad frame: ${error instanceof Error ? error.message : 'unknown'}` });
    });
  });
  ws.addEventListener('close', () => {
    void fail('Disconnected from the runtime.');
  });
  ws.addEventListener('error', () => {
    void fail('Could not reach the runtime.');
  });
}

async function handleFrame(raw: string): Promise<void> {
  if (raw.length > LIMITS.maxMessageBytes) return;
  let frame: Record<string, unknown>;
  try {
    frame = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }

  switch (frame.type) {
    case 'challenge': {
      const current = await state();
      if (!current.clientId || !current.privateKeyJwk) {
        socket?.close(4401, 'not paired');
        return;
      }
      const nonce = String(frame.nonce ?? '');
      const signature = await signChallenge(current.privateKeyJwk, current.clientId, nonce);
      send({
        type: 'hello',
        clientId: current.clientId,
        nonce,
        ts: Date.now(),
        signature,
        agent: 'chrome-extension',
      });
      return;
    }
    case 'sync': {
      const enabledOrigins = Array.isArray(frame.enabledOrigins) ? (frame.enabledOrigins as string[]) : [];
      const deep = Array.isArray(frame.deepCaptureOrigins) ? (frame.deepCaptureOrigins as string[]) : [];
      const enums = Array.isArray(frame.enumCaptureOrigins) ? (frame.enumCaptureOrigins as string[]) : [];
      syncLog.push(`${enabledOrigins.join('|')}#${deep.join('|')}`);
      if (syncLog.length > 20) syncLog.splice(0, syncLog.length - 20);
      const serverCapturing = Array.isArray(frame.capturing) ? (frame.capturing as string[]) : [];
      // The runtime is authoritative for capture state: after a reconnect its
      // set is what counts, otherwise discovery silently stops while the
      // extension still believes it is recording.
      await setState(() => ({
        capturing: serverCapturing.filter((origin) => enabledOrigins.includes(origin)),
        enabledOrigins,
        deepCaptureOrigins: deep,
        enumCaptureOrigins: enums,
        lastError: null,
        lastConnectedAt: new Date().toISOString(),
      }));
      cache = await getState();
      connected = true;
      ready = true;
      reconnectDelay = RECONNECT_MIN_MS;
      flushOutbox();
      await refreshBadge();
      await refreshWebRequestListeners();
      void publishStatus();
      return;
    }
    case 'execute': {
      // Parse, do not cast: a malformed frame must not become a fetch with an
      // undefined timeout (which aborts after 0 ms).
      const parsed = ExecuteMessageSchema.safeParse(frame);
      if (!parsed.success) {
        await setState({ lastError: 'The runtime sent an invalid execute frame.' });
        return;
      }
      void handleExecute(parsed.data);
      return;
    }
    case 'discovery_start': {
      const origin = String(frame.origin ?? '');
      if (!/^https?:\/\//.test(origin)) return;
      // Compute inside the write queue: `sync` and `discovery_start` arrive
      // together, and a snapshot taken here would undo the other one.
      await setState((current) => {
        const capturingNext = new Set(current.capturing);
        capturingNext.add(origin);
        const deepNext = new Set(current.deepCaptureOrigins);
        if (frame.deepCapture === true) deepNext.add(origin);
        const enumNext = new Set(current.enumCaptureOrigins);
        if (frame.captureEnums === true) enumNext.add(origin);
        return {
          capturing: [...capturingNext],
          deepCaptureOrigins: [...deepNext],
          enumCaptureOrigins: [...enumNext],
        };
      });
      cache = await getState();
      await refreshWebRequestListeners();
      void publishStatus();
      return;
    }
    case 'discovery_stop': {
      const origin = String(frame.origin ?? '');
      await setState((current) => {
        // Stopping capture also stops schema capture for that origin; otherwise
        // a later start silently re-enables deep capture the user turned off.
        const capturingNext = new Set(current.capturing);
        capturingNext.delete(origin);
        const deepNext = new Set(current.deepCaptureOrigins);
        deepNext.delete(origin);
        return { capturing: [...capturingNext], deepCaptureOrigins: [...deepNext] };
      });
      cache = await getState();
      void publishStatus();
      return;
    }
    case 'cancel': {
      const id = String(frame.id ?? '');
      cancelled.add(id);
      inflight.get(id)?.abort();
      inflight.delete(id);
      return;
    }
    case 'ping':
      send({ type: 'pong', ts: Date.now() });
      return;
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function resultFrame(id: string, patch: Partial<ResultMessage>): ResultMessage {
  return {
    type: 'result',
    id,
    ok: false,
    status: 0,
    headers: {},
    latencyMs: 0,
    truncated: false,
    bodyEncoding: 'utf8',
    ...patch,
  } as ResultMessage;
}

/**
 * Read a response body with a hard byte cap.
 *
 * `arrayBuffer()` reads everything first, so one large download could exhaust
 * the service worker (and the abort timer used to be cleared before the read).
 */
async function readCapped(response: Response, signal: AbortSignal): Promise<{ text: string; truncated: boolean; bytes: number }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: '', truncated: false, bytes: 0 };
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  for (;;) {
    if (signal.aborted) {
      await reader.cancel().catch(() => undefined);
      break;
    }
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (bytes + value.byteLength > MAX_RESPONSE_BYTES) {
      const room = MAX_RESPONSE_BYTES - bytes;
      if (room > 0) {
        chunks.push(value.subarray(0, room));
        bytes += room;
      }
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    bytes += value.byteLength;
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // Never cut a multi-byte UTF-8 character in half.
  let end = merged.byteLength;
  while (end > 0 && (merged[end - 1] & 0b1100_0000) === 0b1000_0000) end -= 1;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(merged.subarray(0, end));
  return { text, truncated: truncated || end < merged.byteLength, bytes };
}

async function fetchCsrfToken(
  baseOrigin: string,
  domain: string,
  csrf: { bootstrapPath: string; tokenField: string; header: string },
): Promise<string | null> {
  // The bootstrap call must stay on the same origin as the tool, including the
  // port, so derive it from the already-validated request URL.
  const target = new URL(csrf.bootstrapPath, baseOrigin).toString();
  const checked = checkTargetUrl(target, domain, { expectedOrigin: baseOrigin });
  if (!checked.ok || !checked.url) return null;
  // The bootstrap call is on the critical path: bound it in time and size.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(checked.url.toString(), {
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > MAX_CSRF_BYTES) return null;
    const text = (await response.text()).slice(0, MAX_CSRF_BYTES);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const value = parsed[csrf.tokenField];
    return typeof value === 'string' && value.length > 0 && value.length < 4096 ? value : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function handleExecute(message: ExecuteMessage): Promise<void> {
  const started = Date.now();
  const current = await state();
  lastExecute = { url: message.url };

  try {
    if (!current.enabledOrigins.includes(message.origin)) {
      send(
        resultFrame(message.id, {
          error: { code: ErrorCode.DOMAIN_NOT_ALLOWED, message: `This browser has not been authorised for ${message.origin}.` },
        }),
      );
      return;
    }

    let hostname: string;
    try {
      hostname = new URL(message.url).hostname;
    } catch {
      send(resultFrame(message.id, { error: { code: ErrorCode.INVALID_URL, message: 'The request URL is not parseable.' } }));
      return;
    }
    // Both checks are independent: the URL must be on the allowed origin *and*
    // the hostname must be what the runtime said it would be.
    const verdict = checkTargetUrl(message.url, hostname, { expectedOrigin: message.origin });
    if (!verdict.ok || !verdict.url) {
      send(
        resultFrame(message.id, {
          error: { code: verdict.code ?? ErrorCode.INVALID_URL, message: verdict.reason ?? 'The URL was rejected.' },
        }),
      );
      return;
    }

    const headers: Record<string, string> = { ...message.headers };
    if (message.csrf && message.method !== 'GET' && message.method !== 'HEAD') {
      const token = await fetchCsrfToken(verdict.url.origin, hostname, message.csrf);
      if (!token) {
        send(
          resultFrame(message.id, {
            error: {
              code: ErrorCode.WEBSITE_ERROR,
              message: 'Could not obtain a CSRF token from the website.',
              hint: 'Check the CSRF bootstrap path configured for this domain.',
            },
          }),
        );
        return;
      }
      headers[message.csrf.header] = token;
    }

    const controller = new AbortController();
    inflight.set(message.id, controller);
    // The timer covers the body read as well, not just the headers.
    const timer = setTimeout(() => controller.abort(), message.timeoutMs);
    let response: Response;
    let bodyText = '';
    let truncated = false;
    try {
      response = await fetch(verdict.url.toString(), {
        method: message.method,
        headers,
        body: message.body,
        credentials: 'include',
        redirect: 'manual',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (response.type !== 'opaqueredirect' && response.status !== 0) {
        // Stream with a hard cap instead of `arrayBuffer()`, which would
        // materialise a multi-hundred-megabyte body in the worker first.
        const read = await readCapped(response, controller.signal);
        bodyText = read.text;
        truncated = read.truncated;
      }
    } finally {
      clearTimeout(timer);
      inflight.delete(message.id);
    }

    // `redirect: 'manual'` yields an opaque redirect: the browser will not let
    // extension code read the Location header, so every redirect is refused
    // rather than silently followed off-domain.
    if (response.type === 'opaqueredirect' || response.status === 0) {
      send(
        resultFrame(message.id, {
          latencyMs: Date.now() - started,
          error: {
            code: ErrorCode.REDIRECT_BLOCKED,
            message: 'The website answered with a redirect. Redirects are not followed automatically.',
          },
        }),
      );
      return;
    }

    const body = bodyText;

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = value;
    });

    send(
      resultFrame(message.id, {
        ok: true,
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        body,
        latencyMs: Date.now() - started,
        truncated,
      }),
    );
    lastExecute = { url: message.url, status: response.status };

    // Tell the runtime what the website actually answered, so an expired
    // session shows up in the dashboard without the runtime ever seeing a cookie.
    const nextSession = response.status === 401 ? 'expired' : response.status < 400 ? 'ok' : null;
    if (nextSession && sessionState.get(message.origin) !== nextSession) {
      sessionState.set(message.origin, nextSession);
      send({
        type: 'session',
        origin: message.origin,
        status: nextSession,
        httpStatus: response.status,
        at: Date.now(),
      });
    }
  } catch (error) {
    lastExecute = { url: message.url, error: `${error instanceof Error ? `${error.name}: ${error.message}` : 'unknown'}` };
    inflight.delete(message.id);
    const aborted = error instanceof DOMException && error.name === 'AbortError';
    const wasCancelled = cancelled.delete(message.id);
    send(
      resultFrame(message.id, {
        latencyMs: Date.now() - started,
        error: aborted
          ? wasCancelled
            ? { code: ErrorCode.ABORTED, message: 'The call was cancelled.' }
            : { code: ErrorCode.TIMEOUT, message: `The request did not finish within ${message.timeoutMs} ms.` }
          : {
              code: ErrorCode.NETWORK_ERROR,
              message: `The browser could not complete the request (${error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error'}).`,
              hint: 'The site may be offline, blocked, or unreachable from this browser.',
            },
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Discovery plumbing
// ---------------------------------------------------------------------------

async function refreshWebRequestListeners(): Promise<void> {
  const current = await state();
  // Chrome match patterns cannot contain a port, and a pattern without one
  // covers every port on that host. The collector still matches the exact
  // origin, so the coarser filter is only a pre-filter.
  const origins = new Set<string>();
  for (const origin of current.enabledOrigins) {
    try {
      const parsed = new URL(origin);
      origins.add(`${parsed.protocol}//${parsed.hostname}/*`);
    } catch {
      /* ignore a malformed origin; the runtime validates them anyway */
    }
  }

  const granted = await chrome.permissions.getAll();
  const allowed = new Set(granted.origins ?? []);
  const filters = [...origins].filter((origin) => allowed.has(origin));
  if (filters.length === 0) {
    // No granted origin: detach rather than keep observing stale patterns.
    detachWebRequestListeners();
    return;
  }
  if (listenersAttached && filters.join(',') === webRequestFilters.join(',')) return;

  detachWebRequestListeners();
  webRequestFilters = filters;
  try {
    chrome.webRequest.onBeforeRequest.addListener(onBeforeRequest, { urls: filters });
    chrome.webRequest.onCompleted.addListener(onCompleted, { urls: filters }, ['responseHeaders']);
    listenersAttached = true;
  } catch {
    listenersAttached = false;
  }
}

/**
 * Attach the loopback listeners synchronously at module scope.
 *
 * MV3 only wakes a worker for listeners registered during its initial
 * evaluation; registering after an `await` means a suspended worker stops
 * observing until the alarm happens to restart it.
 */
function attachStaticListeners(): void {
  const urls = ['http://127.0.0.1/*', 'http://localhost/*'];
  try {
    chrome.webRequest.onBeforeRequest.addListener(onBeforeRequest, { urls });
    chrome.webRequest.onCompleted.addListener(onCompleted, { urls }, ['responseHeaders']);
    listenersAttached = true;
    webRequestFilters = urls;
  } catch {
    listenersAttached = false;
  }
}

function onBeforeRequest(details: chrome.webRequest.OnBeforeRequestDetails): undefined {
  collector.onBeforeRequest(details);
  return undefined;
}

function onCompleted(details: chrome.webRequest.OnCompletedDetails): void {
  collector.onCompleted(details);
  scheduleFlush();
}

function detachWebRequestListeners(): void {
  if (!listenersAttached) return;
  try {
    chrome.webRequest.onBeforeRequest.removeListener(onBeforeRequest);
    chrome.webRequest.onCompleted.removeListener(onCompleted);
  } catch {
    /* listener was never attached */
  }
  listenersAttached = false;
}

function flushDiscovery(): void {
  if (!connected || !ready) return;
  const events = collector.peek(40);
  if (!events.length) return;
  // Commit only after the frame is on the wire; draining first lost a batch
  // whenever the socket died in the window between the check and the write.
  if (!send({ type: 'discovery', events })) return;
  collector.commit(events.length);
}

let flushDebounce: ReturnType<typeof setTimeout> | null = null;

/**
 * Flush shortly after a new observation instead of waiting for the next tick.
 * A service worker can be suspended between messages, so the buffer must not be
 * the only place an observation lives.
 */
function scheduleFlush(): void {
  if (flushDebounce) return;
  flushDebounce = setTimeout(() => {
    flushDebounce = null;
    flushDiscovery();
  }, 350);
}

function startFlushLoop(): void {
  if (flushTimer) return;
  flushTimer = setInterval(flushDiscovery, 1_200);
}

// ---------------------------------------------------------------------------
// Popup messaging
// ---------------------------------------------------------------------------

async function statusSnapshot() {
  const current = await state();
  return {
    paired: isPaired(current),
    connected,
    runtimeUrl: current.runtimeUrl,
    clientId: current.clientId,
    label: current.label,
    lastError: current.lastError,
    lastConnectedAt: current.lastConnectedAt,
    enabledOrigins: current.enabledOrigins,
    capturing: current.capturing,
    deepCaptureOrigins: current.deepCaptureOrigins,
    enumCaptureOrigins: current.enumCaptureOrigins,
    extensionId: chrome.runtime.id,
  };
}

async function publishStatus(): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: 'ubs:status-changed' });
  } catch {
    // No popup open; nothing to do.
  }
}

async function pair(runtimeUrl: string, code: string): Promise<{ ok: boolean; error?: string }> {
  const base = runtimeUrl.replace(/\/$/, '');
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) {
    return { ok: false, error: 'The runtime address must be a loopback address such as http://127.0.0.1:8777.' };
  }
  const { publicKeyJwk, privateKeyJwk } = await generateKeyPair();
  let response: Response;
  try {
    response = await fetch(`${base}/api/v1/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: code.trim().toUpperCase(),
        extensionId: chrome.runtime.id,
        label: 'Chrome extension',
        publicKeyJwk,
      }),
    });
  } catch {
    return { ok: false, error: `Could not reach a runtime at ${base}.` };
  }
  const payload = (await response.json().catch(() => ({}))) as { clientId?: string; message?: string };
  if (!response.ok || !payload.clientId) {
    return { ok: false, error: payload.message ?? `Pairing failed (HTTP ${response.status}).` };
  }
  // Drop any existing socket first: without this, `connect()` returns early and
  // the extension stays authenticated to the previous runtime.
  try {
    socket?.close(4000, 're-paired');
  } catch {
    /* already gone */
  }
  socket = null;
  connected = false;
  ready = false;
  await setState({
    runtimeUrl: base,
    clientId: payload.clientId,
    privateKeyJwk,
    publicKeyJwk,
    pairedAt: new Date().toISOString(),
    lastError: null,
  });
  cache = await getState();
  await connect();
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message: Record<string, unknown>, _sender, respond) => {
  void (async () => {
    const type = String(message?.type ?? '');
    if (type === 'ubs:status') {
      respond(await statusSnapshot());
      return;
    }
    if (type === 'ubs:pair') {
      respond(await pair(String(message.runtimeUrl ?? ''), String(message.code ?? '')));
      return;
    }
    if (type === 'ubs:unpair') {
      socket?.close(4000, 'unpaired');
      socket = null;
      connected = false;
      await clearPairing();
      cache = await getState();
      await refreshBadge();
      respond({ ok: true });
      return;
    }
    if (type === 'ubs:intent') {
      // The popup has no runtime token; it asks this authenticated socket to act.
      if (!connected) {
        respond({ ok: false, error: 'The runtime is not connected. Reconnect, then try again.' });
        return;
      }
      const ok = send({
        type: 'intent',
        action: message.action,
        origin: message.origin,
        deepCapture: message.deepCapture,
      });
      respond({ ok });
      return;
    }
    if (type === 'ubs:tap') {
      tapMessages += 1;
      // A page can call window.postMessage freely; bound what it can cost us.
      const payload = message.payload as TapEvent | undefined;
      if (!payload || typeof payload.url !== 'string' || payload.url.length > 2048) {
        respond({ ok: false, error: 'invalid tap payload' });
        return;
      }
      const now = Date.now();
      if (now - lastTapAt > 1_000) {
        tapBudget = 0;
        lastTapAt = now;
      }
      tapBudget += 1;
      if (tapBudget > 200) {
        respond({ ok: false, error: 'tap rate limited' });
        return;
      }
      const before = collector.size;
      collector.onTap(payload);
      if (collector.size > before) tapAccepted += 1;
      scheduleFlush();
      respond({ ok: true });
      return;
    }
    if (type === 'ubs:reconnect') {
      reconnectDelay = RECONNECT_MIN_MS;
      if (socket) socket.close(4001, 'manual reconnect');
      socket = null;
      await connect();
      respond({ ok: true });
      return;
    }
    respond({ ok: false, error: 'unknown message' });
  })();
  return true;
});

attachStaticListeners();
chrome.runtime.onSuspend.addListener(() => {
  // Best effort: flush whatever discovery buffered before the worker is torn down.
  flushDiscovery();
});

chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
  void connect();
});
chrome.runtime.onStartup.addListener(() => {
  void chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
  void connect();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  if (!connected && !socket) void connect();
});
chrome.permissions.onAdded.addListener(() => {
  void refreshWebRequestListeners();
});

// Boot immediately: the worker can be restarted at any time by Chrome.
void (async () => {
  cache = await getState();
  await refreshBadge();
  startFlushLoop();
  await refreshWebRequestListeners();
  await connect();
})();
