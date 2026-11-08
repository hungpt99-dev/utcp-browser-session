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
  /** Domains the runtime has approved for this browser. */
  enabledDomains: string[];
  /** Domains with page-level schema capture enabled. */
  deepCapture: string[];
  /** Domains currently recording traffic. */
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
  enabledDomains: [],
  deepCapture: [],
  capturing: [],
};

const KEY = 'ubs:state';

export async function getState(): Promise<ExtensionState> {
  const stored = await chrome.storage.local.get(KEY);
  return { ...DEFAULT_STATE, ...((stored[KEY] as Partial<ExtensionState> | undefined) ?? {}) };
}

/**
 * Writes are serialised.
 *
 * `setState` is read-modify-write, and the service worker handles several frames
 * concurrently (`sync` and `discovery_start` routinely arrive together). Without
 * a queue, two writers read the same snapshot and the second one silently
 * discards the first one's change — which showed up as a domain that was
 * "enabled" but never "capturing".
 */
let writeQueue: Promise<unknown> = Promise.resolve();

export function setState(patch: Partial<ExtensionState>): Promise<ExtensionState> {
  const next = writeQueue.then(async () => {
    const current = await getState();
    const merged = { ...current, ...patch };
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
    enabledDomains: [],
    deepCapture: [],
    capturing: [],
  });
}

export function isPaired(state: ExtensionState): boolean {
  return !!state.clientId && !!state.privateKeyJwk;
}
