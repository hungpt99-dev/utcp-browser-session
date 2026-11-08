/**
 * UTCP Browser Session provider.
 *
 * This is a first-class UTCP transport plugin, not an MCP server in disguise:
 *
 *   - `BrowserSessionCommunicationProtocol` extends the official
 *     `CommunicationProtocol` abstract class and is registered under the
 *     `utcp_browser_session` call-template type.
 *   - A matching `Serializer` is registered with `CallTemplateSerializer`, so
 *     manuals round-trip through the SDK's own validation.
 *   - Manifests are real `UtcpManual` documents validated with `UtcpManualSchema`.
 *
 * The provider never talks to a website directly. It forwards invocations to the
 * local runtime, which owns the browser connection, the approvals and the audit
 * trail.
 */
import {
  CallTemplateSerializer,
  CommunicationProtocol,
  Serializer,
  UtcpClient,
  UtcpManualSchema,
  type CallTemplate,
  type IUtcpClient,
  type RegisterManualResult,
  type UtcpClientConfig,
  type UtcpManual,
} from '@utcp/sdk';
import { z } from 'zod';
import { CALL_TEMPLATE_TYPE, ErrorCode, ToolError, toErrorShape, type ExecutionEnvelope } from '@utcp-browser-session/shared';

export { CALL_TEMPLATE_TYPE };
export const TOKEN_VARIABLE = 'UTCP_BROWSER_SESSION_TOKEN';
export const DEFAULT_RUNTIME_URL = 'http://127.0.0.1:8777';

export interface BrowserSessionCallTemplate extends CallTemplate {
  call_template_type: typeof CALL_TEMPLATE_TYPE;
  /** Base URL of the local runtime, e.g. http://127.0.0.1:8777 */
  runtime_url: string;
  /** Bearer token for the runtime; pass a variable reference like `${UTCP_BROWSER_SESSION_TOKEN}`. */
  pairing_token?: string;
  /** Which manual to fetch. Defaults to the runtime's configured manual name. */
  manual_name?: string;
  /** Set on tool-level templates: the tool key inside the runtime. */
  tool?: string;
  domain?: string;
  method?: string;
  path_template?: string;
  param_locations?: Record<string, string>;
  permission?: string;
  timeout_ms?: number;
}

export const BrowserSessionCallTemplateSchema = z.object({
  name: z.string().optional(),
  call_template_type: z.literal(CALL_TEMPLATE_TYPE),
  runtime_url: z.string().url(),
  pairing_token: z.string().optional(),
  manual_name: z.string().optional(),
  tool: z.string().optional(),
  domain: z.string().optional(),
  method: z.string().optional(),
  path_template: z.string().optional(),
  param_locations: z.record(z.string()).optional(),
  permission: z.string().optional(),
  timeout_ms: z.number().int().positive().max(120_000).optional(),
  allowed_communication_protocols: z.array(z.string()).optional(),
});

/**
 * Serializer for our call template type. Registering it makes
 * `CallTemplateSerializer.validateDict` able to validate manuals that contain
 * browser-session tools.
 */
export class BrowserSessionCallTemplateSerializer extends Serializer<CallTemplate> {
  override toDict(obj: CallTemplate): Record<string, unknown> {
    const template = obj as BrowserSessionCallTemplate;
    const out: Record<string, unknown> = {
      name: template.name,
      call_template_type: CALL_TEMPLATE_TYPE,
      runtime_url: template.runtime_url,
    };
    if (template.pairing_token !== undefined) out.pairing_token = template.pairing_token;
    if (template.manual_name !== undefined) out.manual_name = template.manual_name;
    if (template.tool !== undefined) out.tool = template.tool;
    if (template.domain !== undefined) out.domain = template.domain;
    if (template.method !== undefined) out.method = template.method;
    if (template.path_template !== undefined) out.path_template = template.path_template;
    if (template.param_locations !== undefined) out.param_locations = template.param_locations;
    if (template.permission !== undefined) out.permission = template.permission;
    if (template.timeout_ms !== undefined) out.timeout_ms = template.timeout_ms;
    if (template.allowed_communication_protocols !== undefined) {
      out.allowed_communication_protocols = template.allowed_communication_protocols;
    }
    return out;
  }

  override validateDict(obj: Record<string, unknown>): CallTemplate {
    return BrowserSessionCallTemplateSchema.parse(obj) as BrowserSessionCallTemplate;
  }
}

/** Error thrown when the runtime reports a structured failure. */
export class BrowserSessionToolError extends ToolError {
  readonly envelope: ExecutionEnvelope;

  constructor(envelope: ExecutionEnvelope) {
    const shape = envelope.error ?? { code: ErrorCode.INTERNAL_ERROR, message: 'Unknown runtime failure.' };
    super(shape.code, shape.message, { details: { executionId: envelope.executionId, domain: envelope.domain } });
    this.name = 'BrowserSessionToolError';
    this.envelope = envelope;
  }
}

interface ManualFetch {
  manual: UtcpManual;
  raw: unknown;
}

function resolveUrl(base: string, pathname: string): string {
  return new URL(pathname, base.endsWith('/') ? base : `${base}/`).toString();
}

export class BrowserSessionCommunicationProtocol extends CommunicationProtocol {
  readonly call_template_type = CALL_TEMPLATE_TYPE;
  private readonly aborter = new AbortController();

  override async registerManual(_caller: IUtcpClient, manualCallTemplate: CallTemplate): Promise<RegisterManualResult> {
    const template = manualCallTemplate as BrowserSessionCallTemplate;
    const errors: string[] = [];
    try {
      const { manual } = await this.fetchManual(template);
      const invalid = manual.tools.filter((tool) => tool.tool_call_template?.call_template_type !== CALL_TEMPLATE_TYPE);
      if (invalid.length) {
        errors.push(
          `Runtime returned ${invalid.length} tool(s) that are not ${CALL_TEMPLATE_TYPE}: ${invalid
            .map((tool) => tool.name)
            .slice(0, 5)
            .join(', ')}`,
        );
      }
      if (!manual.tools.length) {
        errors.push(
          `The runtime has no approved tools for manual "${template.manual_name ?? 'default'}". Approve at least one tool in the dashboard.`,
        );
      }
      if (errors.length) {
        return { manualCallTemplate, manual, success: false, errors };
      }
      return { manualCallTemplate, manual, success: true, errors: [] };
    } catch (error) {
      const shape = toErrorShape(error);
      return {
        manualCallTemplate,
        manual: { utcp_version: '1.0', manual_version: '1.0', tools: [] },
        success: false,
        errors: [`${shape.code}: ${shape.message}`],
      };
    }
  }

  override async deregisterManual(_caller: IUtcpClient, _manualCallTemplate: CallTemplate): Promise<void> {
    // Stateless transport: nothing to tear down beyond the fetch in flight.
  }

  override async callTool(
    _caller: IUtcpClient,
    toolName: string,
    toolArgs: Record<string, any>,
    toolCallTemplate: CallTemplate,
  ): Promise<any> {
    const template = toolCallTemplate as BrowserSessionCallTemplate;
    const { args, confirm } = splitConfirmation(toolArgs);
    const envelope = await this.execute(template, template.tool ?? toolName, args, confirm);
    if (!envelope.ok) throw new BrowserSessionToolError(envelope);
    return envelope;
  }

  override async *callToolStreaming(
    caller: IUtcpClient,
    toolName: string,
    toolArgs: Record<string, any>,
    toolCallTemplate: CallTemplate,
  ): AsyncGenerator<any, void, unknown> {
    yield await this.callTool(caller, toolName, toolArgs, toolCallTemplate);
  }

  override async close(): Promise<void> {
    this.aborter.abort();
  }

  private authHeaders(template: BrowserSessionCallTemplate): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (template.pairing_token) {
      if (/^\$\{[A-Za-z0-9_]+\}$/.test(template.pairing_token)) {
        throw new ToolError(
          ErrorCode.AUTH_REQUIRED,
          `The call template references ${template.pairing_token}, but the variable was not resolved.`,
          { hint: `Put your runtime token in the "${TOKEN_VARIABLE}" variable (or pass token to createBrowserSessionClient).` },
        );
      }
      headers.authorization = `Bearer ${template.pairing_token}`;
    }
    return headers;
  }

  private async fetchManual(template: BrowserSessionCallTemplate): Promise<ManualFetch> {
    if (!template.runtime_url) {
      throw new ToolError(ErrorCode.INVALID_REQUEST, 'The call template has no runtime_url.');
    }
    const url = new URL(resolveUrl(template.runtime_url, '/api/v1/manual'));
    if (template.manual_name) url.searchParams.set('manual', template.manual_name);

    const response = await fetch(url, {
      headers: this.authHeaders(template),
      signal: AbortSignal.any([this.aborter.signal, AbortSignal.timeout(template.timeout_ms ?? 15_000)]),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new ToolError(
        response.status === 401 ? ErrorCode.AUTH_REQUIRED : ErrorCode.INTERNAL_ERROR,
        `The runtime refused to serve its manual (HTTP ${response.status}).`,
        { hint: 'Check that the runtime is running and the token matches the one it printed at startup.' },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ToolError(ErrorCode.INVALID_RESPONSE, 'The runtime returned a manual that is not JSON.');
    }
    const manual = UtcpManualSchema.parse(parsed);
    return { manual, raw: parsed };
  }

  private async execute(
    template: BrowserSessionCallTemplate,
    toolName: string,
    args: Record<string, unknown>,
    confirm: boolean,
  ): Promise<ExecutionEnvelope> {
    if (!template.runtime_url) {
      throw new ToolError(ErrorCode.INVALID_REQUEST, 'The call template has no runtime_url.');
    }
    const url = resolveUrl(template.runtime_url, '/api/v1/execute');
    const timeout = template.timeout_ms ?? 30_000;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: this.authHeaders(template),
        body: JSON.stringify({ tool: toolName, args, confirm, actor: 'utcp' }),
        signal: AbortSignal.any([this.aborter.signal, AbortSignal.timeout(timeout + 5_000)]),
      });
    } catch (error) {
      throw new ToolError(ErrorCode.NETWORK_ERROR, 'Could not reach the local runtime.', {
        hint: `Is the runtime running at ${template.runtime_url}?`,
        details: { reason: error instanceof Error ? error.message : 'unknown' },
      });
    }
    const text = await response.text();
    let envelope: ExecutionEnvelope;
    try {
      envelope = JSON.parse(text) as ExecutionEnvelope;
    } catch {
      throw new ToolError(ErrorCode.INVALID_RESPONSE, `The runtime returned non-JSON (HTTP ${response.status}).`);
    }
    if (response.status === 401) {
      throw new ToolError(ErrorCode.AUTH_REQUIRED, 'The runtime rejected the pairing token.');
    }
    return envelope;
  }
}

/**
 * `__confirm` is the one reserved argument name. Destructive tools require it;
 * it is stripped before the request is built so it can never reach a website.
 */
export function splitConfirmation(args: Record<string, unknown>): { args: Record<string, unknown>; confirm: boolean } {
  const { __confirm, ...rest } = args ?? {};
  return { args: rest, confirm: __confirm === true || __confirm === 'true' };
}

let registered = false;

/** Register the transport with the SDK. Idempotent. */
export function registerBrowserSessionProtocol(): void {
  CommunicationProtocol.communicationProtocolFactories[CALL_TEMPLATE_TYPE] = () => new BrowserSessionCommunicationProtocol();
  CallTemplateSerializer.registerCallTemplate(CALL_TEMPLATE_TYPE, new BrowserSessionCallTemplateSerializer(), true);
  registered = true;
}

export function isProtocolRegistered(): boolean {
  return registered;
}

export interface CreateClientOptions {
  /** Runtime base URL. */
  runtimeUrl?: string;
  /** Runtime bearer token. */
  token: string;
  /** Manual name to load; defaults to the runtime's configured name. */
  manualName?: string;
  /** Name of the manual inside the UTCP client. */
  clientManualName?: string;
}

export interface BrowserSessionClient {
  client: UtcpClient;
  manual: RegisterManualResult;
}

/**
 * Create a real `UtcpClient` with the browser-session manual registered.
 *
 * ```ts
 * const { client } = await createBrowserSessionClient({ token });
 * const tools = await client.getTools();
 * await client.callTool('browser.list_tasks', { status: 'open' });
 * ```
 */
export async function createBrowserSessionClient(options: CreateClientOptions): Promise<BrowserSessionClient> {
  registerBrowserSessionProtocol();
  const runtimeUrl = options.runtimeUrl ?? DEFAULT_RUNTIME_URL;
  const manualName = options.clientManualName ?? options.manualName ?? 'browser';
  // The SDK namespaces variables per manual (`<manual>_<VAR>`), so the token is
  // supplied under both names.
  const config = {
    variables: {
      [TOKEN_VARIABLE]: options.token,
      [`${manualName}_${TOKEN_VARIABLE}`]: options.token,
    },
  } as unknown as UtcpClientConfig;

  const client = await UtcpClient.create(process.cwd(), config);
  const manual = await client.registerManual({
    name: manualName,
    call_template_type: CALL_TEMPLATE_TYPE,
    runtime_url: runtimeUrl,
    pairing_token: `\${${TOKEN_VARIABLE}}`,
    ...(options.manualName ? { manual_name: options.manualName } : {}),
  } as CallTemplate);

  return { client, manual };
}
