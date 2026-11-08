/** Persistent extension state. Nothing here is a website credential. */
export interface ExtensionState {
  runtimeUrl: string;
  clientId: string | null;
  privateKeyJwk: JsonWebKey | null;
  publicKeyJwk: JsonWebKey | null;
  label: string;
  pairedAt: string | null;
  lastConnectedAt: string | null;
  lastError: string | null;
  /** Origins (`scheme://host[:port]`) the runtime has approved for this browser. */
  enabledOrigins: string[];
  /** Origins with page-level schema capture enabled. */
  deepCaptureOrigins: string[];
  /** Origins allowed to report short enum-like value sets. */
  enumCaptureOrigins: string[];
  /** Origins currently recording traffic. */
  capturing: string[];
}

export const DEFAULT_STATE: ExtensionState = {
  runtimeUrl: 'http://127.0.0.1:8777',
  clientId: null,
  privateKeyJwk: null,
  publicKeyJwk: null,
  label: 'Chrome extension',
  pairedAt: null,
  lastConnectedAt: null,
  lastError: null,
  enabledOrigins: [],
  deepCaptureOrigins: [],
  enumCaptureOrigins: [],
  capturing: [],
};

const KEY = 'ubs:state';

type LegacyState = Partial<ExtensionState> & { enabledDomains?: string[]; deepCapture?: string[] };

function originForDomain(domain: string): string {
  return domain.startsWith('127.') || domain === 'localhost' ? `http://${domain}` : `https://${domain}`;
}

/** v1 stored bare hostnames; lift them to origins (the runtime resyncs anyway). */
function migrate(stored: LegacyState): ExtensionState {
  const merged: ExtensionState = { ...DEFAULT_STATE, ...stored };
  delete (merged as LegacyState).enabledDomains;
  delete (merged as LegacyState).deepCapture;
  if (merged.enabledOrigins.length === 0 && stored.enabledDomains?.length) {
    merged.enabledOrigins = stored.enabledDomains.map(originForDomain);
    merged.deepCaptureOrigins = (stored.deepCapture ?? []).map(originForDomain);
  }
  return merged;
}

export async function getState(): Promise<ExtensionState> {
  const stored = await chrome.storage.local.get(KEY);
  return migrate((stored[KEY] as LegacyState | undefined) ?? {});
}

/**
 * Writes are serialised.
 *
 * `setState` is read-modify-write, and the service worker handles several frames
 * concurrently (`sync` and `discovery_start` routinely arrive together). Without
 * a queue, two writers read the same snapshot and the second one silently
 * discards the first one's change — which showed up as an origin that was
 * "enabled" but never "capturing".
 */
let writeQueue: Promise<unknown> = Promise.resolve();

export type StatePatch = Partial<ExtensionState> | ((current: ExtensionState) => Partial<ExtensionState>);

export function setState(patch: StatePatch): Promise<ExtensionState> {
  const next = writeQueue.then(async () => {
    const current = await getState();
    // A function patch is evaluated *inside* the queue, against the value that
    // actually won the previous write. Callers that computed a set from a stale
    // module-level cache used to erase each other.
    const resolved = typeof patch === 'function' ? patch(current) : patch;
    const merged = { ...current, ...resolved };
    await chrome.storage.local.set({ [KEY]: merged });
    return merged;
  });
  // Keep the chain alive even if one write rejects.
  writeQueue = next.catch(() => undefined);
  return next;
}

export async function clearPairing(): Promise<ExtensionState> {
  return setState({
    clientId: null,
    privateKeyJwk: null,
    publicKeyJwk: null,
    pairedAt: null,
    lastConnectedAt: null,
    lastError: null,
    enabledOrigins: [],
    deepCaptureOrigins: [],
    enumCaptureOrigins: [],
    capturing: [],
  });
}

export function isPaired(state: ExtensionState): boolean {
  return !!state.clientId && !!state.privateKeyJwk;
}
