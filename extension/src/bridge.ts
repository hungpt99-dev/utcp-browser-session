/**
 * Isolated-world bridge.
 *
 * MAIN-world code cannot use `chrome.*`, so the tap posts window messages and
 * this script relays them to the service worker. Only messages tagged with our
 * private marker from this same window are forwarded.
 */
(() => {
  const TAG = '__utcp_tap__';

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;
    const data = event.data as Record<string, unknown> | null;
    if (!data || data[TAG] !== true) return;
    const payload = data.payload;
    if (!payload || typeof payload !== 'object') return;
    try {
      chrome.runtime.sendMessage({ type: 'ubs:tap', payload });
    } catch {
      // Service worker is restarting; the observation is simply lost.
    }
  });
})();
