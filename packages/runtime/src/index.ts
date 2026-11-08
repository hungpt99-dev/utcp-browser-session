#!/usr/bin/env node
/**
 * Individual runtime commands.
 *
 * `up` / `down` live in `cli.ts`; this module keeps the long-standing verbs
 * (`serve`, `pair`, `status`, `tools`, `manual`, `call`) so scripts and docs
 * that predate the launcher keep working.
 */
import { createRuntime } from './runtime.ts';
import { loadConfig } from './config.ts';
import { ensureToken } from './token.ts';

function usage(): void {
  process.stdout.write(`utcp-browser-session <command>

Commands:
  up [--demo]               Start the runtime, prepare pairing and open Chrome
  down                      Stop a runtime started by 'up'
  serve                     Start the local runtime only (manual pairing)
  pair                      Create a one-time pairing code for the extension
  status                    Show browser connection and inventory counters
  tools [--all]             List approved tools (or every tool with --all)
  manual                    Print the generated UTCP manual as JSON
  call <tool> [json]        Invoke a tool through the runtime
  help                      Show this message

Environment:
  UBS_PORT                  Runtime port (default 8777)
  UBS_DATA_DIR              State directory (default ~/.utcp-browser-session)
  UBS_TOKEN                 Override the admin bearer token
  UBS_AGENT_TOKEN           Override the execute-only token given to UTCP clients
  UBS_DASHBOARD_DIR         Directory with the built dashboard
  UTCP_BROWSER_SESSION_TOKEN  Token used by the UTCP provider and by "call"
`);
}

async function api(url: string, token: string, pathname: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${url}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${response.status}: ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

export async function runCommand(command: string, rest: string[]): Promise<number> {
  if (command === 'help' || command === '--help' || command === '-h') {
    usage();
    return 0;
  }

  if (command === 'serve') {
    const runtime = await createRuntime({});
    process.stdout.write(
      [
        '',
        '  UTCP Browser Session runtime',
        `  listening   ${runtime.url}`,
        `  state       ${runtime.config.dataDir}`,
        `  admin token ${runtime.token}`,
        `  agent token ${runtime.agentToken}   (this is what a UTCP client uses)`,
        '',
        `  Dashboard   ${runtime.url}/#token=${runtime.token}`,
        '',
        '  Next: run `utcp-browser-session up` instead to get the browser and',
        '  pairing handled for you, or mint a code with `utcp-browser-session pair`.',
        '',
      ].join('\n'),
    );
    const shutdown = async (signal: string) => {
      process.stdout.write(`\n  ${signal} received, shutting down.\n`);
      await runtime.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    await new Promise<void>(() => undefined);
    return 0;
  }

  const config = loadConfig({});
  // CLI commands are administrative: they use the admin token, never the
  // execute-only token an agent holds.
  const token = process.env.UBS_TOKEN ?? ensureToken(config.dataDir);
  const base = config.publicUrl;

  if (command === 'pair') {
    const result = (await api(base, token, '/api/v1/pair/start', { method: 'POST' })) as { code: string; expiresAt: string };
    process.stdout.write(`\n  Pairing code: ${result.code}\n  Expires:      ${result.expiresAt}\n\n`);
    return 0;
  }

  if (command === 'status') {
    const status = (await api(base, token, '/api/v1/status')) as Record<string, unknown>;
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return 0;
  }

  if (command === 'tools') {
    const all = rest.includes('--all');
    const result = (await api(base, token, `/api/v1/tools${all ? '' : '?status=approved'}`)) as {
      tools: Array<{ fqName: string; status: string; permission: string; method: string; pathTemplate: string; domain: string }>;
    };
    if (!result.tools.length) {
      process.stdout.write('  No tools.\n');
      return 0;
    }
    for (const tool of result.tools) {
      process.stdout.write(`  ${tool.status.padEnd(9)} ${tool.permission.padEnd(12)} ${tool.fqName.padEnd(34)} ${tool.method} ${tool.pathTemplate}\n`);
    }
    return 0;
  }

  if (command === 'manual') {
    const manual = await api(base, token, '/api/v1/manual');
    process.stdout.write(`${JSON.stringify(manual, null, 2)}\n`);
    return 0;
  }

  if (command === 'call') {
    const toolName = rest[0];
    if (!toolName) {
      process.stderr.write('  Usage: utcp-browser-session call <tool> [json-args]\n');
      return 2;
    }
    const args = rest[1] ? (JSON.parse(rest[1]) as Record<string, unknown>) : {};
    const confirm = rest.includes('--confirm');
    const result = await api(base, token, '/api/v1/execute', {
      method: 'POST',
      body: JSON.stringify({ tool: toolName, args, confirm, actor: 'cli' }),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  process.stderr.write(`  Unknown command "${command}".\n`);
  usage();
  return 2;
}

// Direct execution: `node packages/runtime/src/index.ts <command>`.
if (process.argv[1] && /(?:^|\/)index\.ts$/.test(process.argv[1])) {
  const [, , command = 'serve', ...rest] = process.argv;
  void runCommand(command, rest).then((code) => process.exit(code));
}
