/**
 * Stable, machine-readable error codes.
 *
 * Every rejection the runtime or provider produces carries one of these codes so
 * that callers (agents, tests, the dashboard) can branch on structure instead of
 * on message text.
 */
export const ErrorCode = {
  // Request shape
  INVALID_REQUEST: 'invalid_request',
  INVALID_ARGUMENTS: 'invalid_arguments',
  UNKNOWN_TOOL: 'unknown_tool',
  UNSUPPORTED_METHOD: 'unsupported_method',

  // Policy
  DOMAIN_NOT_ALLOWED: 'domain_not_allowed',
  TOOL_NOT_APPROVED: 'tool_not_approved',
  TOOL_REVOKED: 'tool_revoked',
  PERMISSION_DENIED: 'permission_denied',
  CONFIRMATION_REQUIRED: 'confirmation_required',
  RATE_LIMITED: 'rate_limited',
  APPROVAL_REQUIRED: 'approval_required',

  // Target validation
  INVALID_URL: 'invalid_url',
  URL_SCHEME_NOT_ALLOWED: 'url_scheme_not_allowed',
  CROSS_DOMAIN_BLOCKED: 'cross_domain_blocked',
  REDIRECT_BLOCKED: 'redirect_blocked',
  PRIVATE_ADDRESS_BLOCKED: 'private_address_blocked',

  // Payload limits
  REQUEST_TOO_LARGE: 'request_too_large',
  RESPONSE_TOO_LARGE: 'response_too_large',
  UNSUPPORTED_CONTENT_TYPE: 'unsupported_content_type',

  // Runtime / transport
  EXTENSION_DISCONNECTED: 'extension_disconnected',
  TIMEOUT: 'timeout',
  ABORTED: 'aborted',
  AUTH_REQUIRED: 'auth_required',
  PAIRING_REQUIRED: 'pairing_required',
  PAIRING_INVALID: 'pairing_invalid',
  REPLAY_DETECTED: 'replay_detected',
  BAD_SIGNATURE: 'bad_signature',
  MESSAGE_TOO_LARGE: 'message_too_large',
  INVALID_MESSAGE: 'invalid_message',
  ORIGIN_NOT_ALLOWED: 'origin_not_allowed',

  // Website-side
  WEBSITE_AUTH_EXPIRED: 'website_auth_expired',
  WEBSITE_ERROR: 'website_error',
  NETWORK_ERROR: 'network_error',
  INVALID_RESPONSE: 'invalid_response',
  INTERNAL_ERROR: 'internal_error',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Error codes that indicate the user's browser session needs attention. */
export const RECONNECT_CODES: ReadonlySet<string> = new Set([
  ErrorCode.WEBSITE_AUTH_EXPIRED,
  ErrorCode.EXTENSION_DISCONNECTED,
]);

export interface ToolErrorShape {
  code: string;
  message: string;
  /** Actionable next step for the user, never containing secrets. */
  hint?: string;
  details?: Record<string, unknown>;
}

/**
 * The single error type that crosses module boundaries. It never carries raw
 * headers, cookies or upstream response bodies in `message`.
 */
export class ToolError extends Error {
  readonly code: string;
  readonly hint?: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, options: { hint?: string; details?: Record<string, unknown> } = {}) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
  }

  toShape(): ToolErrorShape {
    const shape: ToolErrorShape = { code: this.code, message: this.message };
    if (this.hint) shape.hint = this.hint;
    if (this.details) shape.details = this.details;
    return shape;
  }
}

export function isToolError(value: unknown): value is ToolError {
  return value instanceof ToolError;
}

/** Normalize anything thrown into a stable, redaction-safe shape. */
export function toErrorShape(error: unknown): ToolErrorShape {
  if (error instanceof ToolError) return error.toShape();
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return { code: ErrorCode.ABORTED, message: 'The request was aborted.' };
    }
    return { code: ErrorCode.INTERNAL_ERROR, message: error.message };
  }
  return { code: ErrorCode.INTERNAL_ERROR, message: 'Unknown failure.' };
}
