#!/usr/bin/env node
/**
 * CLI for the local runtime.
 *
 *   utcp-browser-session serve            start the runtime
 *   utcp-browser-session pair             mint a one-time pairing code
 *   utcp-browser-session status           show connection + inventory
 *   utcp-browser-session tools [--all]    list tools
 *   utcp-browser-session manual           print the generated UTCP manual
 *   utcp-browser-session call <tool> '{}' invoke a tool through the runtime
 */
import { createRuntime } from './runtime.ts';
import { loadConfig } from './config.ts';
import { ensureToken } from './token.ts';

function usage(): void {
  process.stdout.write(`utcp-browser-session <command>

Commands:
  serve                     Start the local runtime (default)
  pair                      Create a one-time pairing code for the extension
  status                    Show browser connection and inventory counters
  tools [--all]             List approved tools (or every tool with --all)
  manual                    Print the generated UTCP manual as JSON
  call <tool> [json]        Invoke a tool through the runtime
  help                      Show this message

Environment:
  UBS_PORT                  Runtime port (default 8777)
  UBS_DATA_DIR              State directory (default ~/.utcp-browser-session)
  UBS_TOKEN                 Override the runtime bearer token
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

async function main(): Promise<void> {
  const [, , command = 'serve', ...rest] = process.argv;

  if (command === 'help' || command === '--help' || command === '-h') {
    usage();
    return;
  }

  if (command === 'serve') {
    const runtime = await createRuntime({});
    process.stdout.write(
      [
        '',
        '  UTCP Browser Session runtime',
        `  listening   ${runtime.url}`,
        `  state       ${runtime.config.dataDir}`,
        `  token       ${runtime.token}`,
        '',
        `  Dashboard   ${runtime.url}/?token=${runtime.token}`,
        '',
        '  Next: mint a pairing code with `utcp-browser-session pair`,',
        '  load the extension, and paste the code into its popup.',
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
    return;
  }

  const config = loadConfig({});
  const token = process.env.UTCP_BROWSER_SESSION_TOKEN ?? ensureToken(config.dataDir);
  const base = config.publicUrl;

  if (command === 'pair') {
    const result = (await api(base, token, '/api/v1/pair/start', { method: 'POST' })) as { code: string; expiresAt: string };
    process.stdout.write(`\n  Pairing code: ${result.code}\n  Expires:      ${result.expiresAt}\n\n`);
    return;
  }

  if (command === 'status') {
    const status = (await api(base, token, '/api/v1/status')) as Record<string, unknown>;
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return;
  }

  if (command === 'tools') {
    const all = rest.includes('--all');
    const result = (await api(base, token, `/api/v1/tools${all ? '' : '?status=approved'}`)) as {
      tools: Array<{ fqName: string; status: string; permission: string; method: string; pathTemplate: string; domain: string }>;
    };
    if (!result.tools.length) {
      process.stdout.write('  No tools.\n');
      return;
    }
    for (const tool of result.tools) {
      process.stdout.write(`  ${tool.status.padEnd(9)} ${tool.permission.padEnd(12)} ${tool.fqName.padEnd(34)} ${tool.method} ${tool.pathTemplate}\n`);
    }
    return;
  }

  if (command === 'manual') {
    const manual = await api(base, token, '/api/v1/manual');
    process.stdout.write(`${JSON.stringify(manual, null, 2)}\n`);
    return;
  }

  if (command === 'call') {
    const toolName = rest[0];
    if (!toolName) {
      process.stderr.write('  Usage: utcp-browser-session call <tool> [json-args]\n');
      process.exit(2);
    }
    const args = rest[1] ? (JSON.parse(rest[1]) as Record<string, unknown>) : {};
    const confirm = rest.includes('--confirm');
    const result = await api(base, token, '/api/v1/execute', {
      method: 'POST',
      body: JSON.stringify({ tool: toolName, args, confirm, actor: 'cli' }),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stderr.write(`  Unknown command "${command}".\n`);
  usage();
  process.exit(2);
}

await main();
