/**
 * UTCP Manual generation.
 *
 * The manual is a plain UTCP document: `utcp_version`, `manual_version` and a
 * list of tools, each carrying a `tool_call_template` whose
 * `call_template_type` is `utcp_browser_session`. Nothing here is invented --
 * the shape comes from `UtcpManualSchema` in @utcp/sdk.
 *
 * Secrets are never embedded. The runtime URL is public (loopback) and the
 * bearer token is expressed as the variable `${UTCP_BROWSER_SESSION_TOKEN}`,
 * which the official SDK resolves from the client's variables at call time.
 */
import {
  CALL_TEMPLATE_TYPE,
  MANUAL_VERSION,
  UTCP_VERSION,
  type ToolRecord,
} from '@utcp-browser-session/shared';
import { UtcpManualSchema } from '@utcp/sdk';
import { registerBrowserSessionProtocol } from '@utcp-browser-session/provider';
import type { Store } from './store.ts';

export const TOKEN_VARIABLE = 'UTCP_BROWSER_SESSION_TOKEN';

export interface ManualOptions {
  manualName: string;
  runtimeUrl: string;
  tokenVariable?: string;
  timeoutMs?: number;
}

export interface UtcpToolDocument {
  name: string;
  description: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  tags: string[];
  average_response_size?: number;
  tool_call_template: Record<string, unknown>;
}

export interface UtcpManualDocument {
  utcp_version: string;
  manual_version: string;
  tools: UtcpToolDocument[];
}

export function buildManual(store: Store, options: ManualOptions): UtcpManualDocument {
  const tokenVariable = options.tokenVariable ?? TOKEN_VARIABLE;
  const tools = store
    .listTools({ status: 'approved' })
    .filter((tool) => store.isDomainEnabled(tool.domain));

  return {
    utcp_version: UTCP_VERSION,
    manual_version: MANUAL_VERSION,
    tools: tools.map((tool) => toUtcpTool(tool, options.runtimeUrl, tokenVariable, options.timeoutMs ?? store.settings.defaultTimeoutMs)),
  };
}

export function toUtcpTool(tool: ToolRecord, runtimeUrl: string, tokenVariable: string, timeoutMs: number): UtcpToolDocument {
  return {
    name: tool.fqName,
    description: tool.description,
    inputs: tool.inputSchema as Record<string, unknown>,
    outputs: tool.outputSchema as Record<string, unknown>,
    tags: tool.tags,
    tool_call_template: {
      name: tool.fqName,
      call_template_type: CALL_TEMPLATE_TYPE,
      runtime_url: runtimeUrl,
      pairing_token: `\${${tokenVariable}}`,
      tool: tool.fqName,
      domain: tool.domain,
      method: tool.method,
      path_template: tool.pathTemplate,
      param_locations: tool.paramLocations,
      permission: tool.permission,
      timeout_ms: timeoutMs,
    },
  };
}

export interface ManualValidationReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  toolCount: number;
  /** Result of the official SDK schema validation (UtcpManualSchema). */
  sdkValid: boolean;
}

/**
 * Structural validation with the official SDK schema.
 *
 * The SDK resolves call templates through its serializer registry, so this
 * registers the transport first; that is the documented extension mechanism and
 * keeps our manual honest against the real schema rather than a lookalike.
 */
export function validateWithSdk(manual: UtcpManualDocument): { ok: boolean; errors: string[] } {
  registerBrowserSessionProtocol();
  const parsed = UtcpManualSchema.safeParse(manual);
  if (parsed.success) return { ok: true, errors: [] };
  const errors = parsed.error.issues.slice(0, 8).map((issue) => `${issue.path.join('.') || 'manual'}: ${issue.message}`);
  return { ok: false, errors };
}

const SECRET_PATTERNS = [
  /(^|[^A-Za-z])eyJ[A-Za-z0-9_-]{8,}\./,
  /\bbearer\s+[A-Za-z0-9._-]{8,}/i,
  /\bsid=[A-Za-z0-9]/,
  /"cookie"\s*:/i,
  /"set-cookie"\s*:/i,
  /"authorization"\s*:\s*"(?!\$\{)[^"]+"/i,
];

/**
 * Validate a generated manual without trusting it.
 *
 * Structural validation uses the official SDK schema (see `validateWithSdk`);
 * the checks here are project policy: namespacing, call-template integrity and
 * absence of credential material.
 */
export function validateManualDocument(manual: UtcpManualDocument, manualName?: string): ManualValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  if (typeof manual.utcp_version !== 'string' || !manual.utcp_version) errors.push('utcp_version is required.');
  if (typeof manual.manual_version !== 'string' || !manual.manual_version) errors.push('manual_version is required.');
  if (!Array.isArray(manual.tools)) errors.push('tools must be an array.');

  for (const tool of manual.tools ?? []) {
    if (!tool.name || typeof tool.name !== 'string') errors.push('A tool is missing a name.');
    if (seen.has(tool.name)) errors.push(`Duplicate tool name "${tool.name}".`);
    seen.add(tool.name);
    if (!tool.description) warnings.push(`Tool "${tool.name}" has an empty description.`);

    const template = tool.tool_call_template ?? {};
    if (!tool.tool_call_template || template.call_template_type !== CALL_TEMPLATE_TYPE) {
      errors.push(`Tool "${tool.name}" does not use call_template_type "${CALL_TEMPLATE_TYPE}".`);
    }
    if (manualName && !String(tool.name).startsWith(`${manualName}.`)) {
      errors.push(`Tool "${tool.name}" is not namespaced under manual "${manualName}".`);
    }
    if (!template.runtime_url) errors.push(`Tool "${tool.name}" has no runtime_url.`);
    if (!template.tool) errors.push(`Tool "${tool.name}" has no tool binding.`);
    if (!template.path_template) errors.push(`Tool "${tool.name}" has no path_template.`);
    if (typeof template.pairing_token !== 'string' || !/^\$\{[A-Z0-9_]+\}$/.test(template.pairing_token)) {
      errors.push(`Tool "${tool.name}" must reference its token as a variable, not a literal value.`);
    }
  }

  // Scan the *raw* document (redaction would hide what we are looking for) and
  // never echo the match itself.
  const raw = JSON.stringify(manual);
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(raw)) {
      errors.push('The manual appears to contain credential material.');
      break;
    }
  }

  const sdk = validateWithSdk(manual);
  if (!sdk.ok) errors.push(...sdk.errors.map((message) => `SDK: ${message}`));

  return { ok: errors.length === 0, errors, warnings, toolCount: manual.tools?.length ?? 0, sdkValid: sdk.ok };
}
