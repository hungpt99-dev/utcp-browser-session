/** Hard limits applied on both sides of every hop. */
export const LIMITS = {
  /** Largest request body a tool may send to a website. */
  maxRequestBytes: 256 * 1024,
  /** Largest response body the runtime will hand back; larger bodies are truncated with a flag. */
  maxResponseBytes: 1024 * 1024,
  /** Largest single websocket message accepted from either side. */
  maxMessageBytes: 512 * 1024,
  /** Default per-invocation timeout. */
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 120_000,
  /** Redirects are inspected, not followed blindly. */
  maxRedirects: 2,
  /** Requests per minute per tool, to stop a runaway agent loop. */
  rateLimitPerMinute: 60,
  /** Pairing code lifetime. */
  pairingCodeTtlMs: 5 * 60_000,
  /** Allowed clock skew for signed handshakes. */
  handshakeSkewMs: 60_000,
  /** Max field/param count accepted in a generated schema. */
  maxSchemaProperties: 64,
  /** Max JSON nesting the schema inferrer will walk. */
  maxSchemaDepth: 6,
} as const;

export const CONTENT_TYPE_JSON = 'application/json';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}
