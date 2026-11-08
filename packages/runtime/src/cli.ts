/**
 * `utcp-browser-session` — the operator-facing entry point.
 *
 *   up      start the runtime, prepare pairing, launch Chrome with the extension
 *   down    stop a runtime started by `up`
 *   serve   run the runtime only (no browser, manual pairing: the old path)
 *   pair / status / tools / manual   the individual commands
 *
 * `up` is what turns the eight-step quick start into three user actions: the
 * build, the extension load and the pairing code are all handled here. Approval
 * is never automated.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRuntime, type RuntimeHandle } from './runtime.ts';
import { ensureToken, ensureAgentToken } from './token.ts';
import { LIMITS } from '@utcp-browser-session/shared';
import { extensionIdForPath } from '../../shared/src/extension-id.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Terminal output. The CLI is a UI, so it writes to the streams directly. */
function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}
function err(line = ''): void {
  process.stderr.write(`${line}\n`);
}

/** Stable exit codes (documented in README and --help). */
export const EXIT = {
  ok: 0,
  usage: 2,
  buildFailed: 3,
  portBusy: 4,
  noBrowser: 5,
  runtimeFailed: 6,
} as const;

export interface UpOptions {
  demo: boolean;
  port: number;
  dataDir: string;
  browser: boolean;
  chromePath: string | null;
  headless: boolean;
}

const USAGE = `utcp-browser-session <command>

  up [options]        start the runtime, prepare pairing and open Chrome
  down                stop the runtime started by 'up'
  serve               run the runtime only (manual pairing)
  pair | status | tools | manual

up options
  --demo              start the bundled fixture site and enable it
  --port <n>          runtime port (default 8777; auto-pair needs the default)
  --data-dir <path>   where tokens and state live (default ~/.utcp-browser-session)
  --chrome <path>     browser binary to launch
  --no-browser        do not launch a browser (pair manually from the popup)
  --headless          launch Chrome headless (sign-in needs a visible window)

exit codes
  0 ok · 2 usage · 3 build failed · 4 port busy · 5 no browser found · 6 runtime failed
`;

export function parseUpOptions(argv: string[]): UpOptions {
  const options: UpOptions = {
    demo: false,
    port: Number(process.env.UBS_PORT ?? 8777),
    dataDir: process.env.UBS_DATA_DIR ?? path.join(os.homedir(), '.utcp-browser-session'),
    browser: true,
    chromePath: process.env.UBS_CHROME ?? null,
    headless: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--demo') options.demo = true;
    else if (arg === '--no-browser') options.browser = false;
    else if (arg === '--headless') options.headless = true;
    else if (arg === '--port') options.port = Number(argv[++index]);
    else if (arg === '--data-dir') options.dataDir = path.resolve(argv[++index]);
    else if (arg === '--chrome') options.chromePath = argv[++index];
    else throw new UsageError(`unknown option: ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new UsageError(`--port must be a TCP port, got ${options.port}`);
  }
  return options;
}

export class UsageError extends Error {}

/** Walk up from the CLI to find the package root (works in a checkout). */
function packageRoot(): string {
  let dir = here;
  for (let depth = 0; depth < 6; depth += 1) {
    if (
      fs.existsSync(path.join(dir, 'extension', 'public', 'manifest.json')) ||
      fs.existsSync(path.join(dir, 'extension', 'dist', 'manifest.json'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(here, '..', '..', '..');
}

export function buildArtifacts(root = packageRoot()): { dashboard: string; extension: string } {
  return {
    dashboard: path.join(root, 'dashboard', 'dist', 'index.html'),
    extension: path.join(root, 'extension', 'dist', 'manifest.json'),
  };
}

/** Build the dashboard and extension when their dist output is missing. */
export function ensureBuild(root = packageRoot(), log: (line: string) => void = out): boolean {
  const artifacts = buildArtifacts(root);
  const missing = Object.entries(artifacts).filter(([, file]) => !fs.existsSync(file));
  if (missing.length === 0) return true;
  log(`  building ${missing.map(([name]) => name).join(' + ')} (first run)…`);
  const result = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) return false;
  return Object.values(buildArtifacts(root)).every((file) => fs.existsSync(file));
}

async function portFree(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(700) });
    return !response.ok;
  } catch {
    return true;
  }
}

/** Locate a Chromium-family browser. */
export function findChrome(explicit: string | null): string | null {
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  const candidates = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome'];
  for (const name of candidates) {
    const which = spawnSync('which', [name], { encoding: 'utf8' });
    if (which.status === 0) return which.stdout.trim();
  }
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (fs.existsSync(cache)) {
    for (const entry of fs.readdirSync(cache)) {
      if (!entry.startsWith('chromium-')) continue;
      const binary = path.join(cache, entry, 'chrome-linux', 'chrome');
      if (fs.existsSync(binary)) return binary;
    }
  }
  return null;
}

interface UpStateFile {
  pid: number;
  port: number;
  url: string;
  dataDir: string;
  demo: boolean;
  siteUrl: string | null;
  startedAt: string;
}

function statePath(dataDir: string): string {
  return path.join(dataDir, 'up.json');
}

function readUpState(dataDir: string): UpStateFile | null {
  try {
    return JSON.parse(fs.readFileSync(statePath(dataDir), 'utf8')) as UpStateFile;
  } catch {
    return null;
  }
}

function writeUpState(dataDir: string, state: UpStateFile): void {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(statePath(dataDir), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export interface UpHandle {
  runtime: RuntimeHandle;
  url: string;
  demo: { origin: string; stop: () => Promise<void> } | null;
  stop: () => Promise<void>;
}

/**
 * Start everything `up` is responsible for, without assuming a terminal or a
 * browser (the E2E test calls this directly).
 */
export async function startUp(options: UpOptions, log: (line: string) => void = out): Promise<UpHandle> {
  const root = packageRoot();
  if (!ensureBuild(root, log)) {
    throw Object.assign(new Error('build failed'), { exitCode: EXIT.buildFailed });
  }
  if (!(await portFree(options.port))) {
    throw Object.assign(new Error(`port ${options.port} is already in use`), { exitCode: EXIT.portBusy });
  }

  const runtime = await createRuntime({
    port: options.port,
    dataDir: options.dataDir,
    autoPair: true,
    logLevel: (process.env.UBS_LOG_LEVEL as 'info' | undefined) ?? 'info',
  });

  /**
   * Keep a fresh one-time pairing code available while nothing is paired yet.
   * It is never renewed once a client exists: a second browser has to pair
   * explicitly, so `up` cannot be used to enrol extra machines silently.
   */
  // Bind the record to the extension id Chrome will assign to this bundle:
  // a different extension cannot take it, even with a forged Origin header.
  const launchedExtensionId = extensionIdForPath(path.join(root, 'extension', 'dist'));
  const refreshAutoPair = (): void => {
    if (runtime.store.listClients().some((client) => !client.revokedAt)) return;
    runtime.store.createAutoPair(120_000, launchedExtensionId);
  };
  refreshAutoPair();
  const autoPairTimer = setInterval(refreshAutoPair, 60_000);
  autoPairTimer.unref?.();

  let demo: UpHandle['demo'] = null;
  if (options.demo) {
    const { createTestSite } = await import('@utcp-browser-session/test-site');
    const site = createTestSite({ port: Number(process.env.UBS_DEMO_PORT ?? 8788) });
    await site.start();
    const origin = site.origin;

    runtime.store.enableDomain(origin, new URL(origin).hostname, {
      deepCapture: true,
      csrf: { bootstrapPath: '/api/csrf', tokenField: 'token', header: 'x-csrf-token' },
    });
    runtime.store.audit({
      kind: 'demo.enabled',
      severity: 'info',
      actor: 'runtime',
      origin,
      message: `Demo site ${origin} enabled with schema capture.`,
    });

    // Start observing as soon as the browser connects, and keep draft tools in
    // sync with what was discovered. Approving stays a human action.
    const begin = (): void => {
      try {
        runtime.hub.startDiscovery(origin, new URL(origin).hostname, true);
      } catch {
        /* no browser yet; 'connected' will fire again */
      }
    };
    runtime.hub.on('connected', begin);
    if (runtime.hub.isConnected) begin();

    let known = 0;
    const timer = setInterval(() => {
      const endpoints = runtime.store.listEndpoints(origin).length;
      if (endpoints > known) {
        known = endpoints;
        try {
          runtime.store.generateDrafts(origin);
        } catch {
          /* generation is best effort; the dashboard button still works */
        }
      }
    }, 1500);
    timer.unref?.();

    demo = {
      origin,
      stop: async () => {
        clearInterval(timer);
        runtime.hub.off('connected', begin);
        await site.stop();
      },
    };
  }

  const url = runtime.url;
  writeUpState(options.dataDir, {
    pid: process.pid,
    port: runtime.port,
    url,
    dataDir: options.dataDir,
    demo: options.demo,
    siteUrl: demo?.origin ?? null,
    startedAt: new Date().toISOString(),
  });

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    clearInterval(autoPairTimer);
    if (demo) await demo.stop();
    await runtime.close();
    try {
      fs.rmSync(statePath(options.dataDir), { force: true });
    } catch {
      /* ignore */
    }
  };

  return { runtime, url, demo, stop };
}

/** Launch Chrome with the extension already loaded, in its own profile. */
export function launchChrome(options: {
  chromePath: string;
  extensionPath: string;
  url: string;
  headless: boolean;
}): ChildProcess {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ubs-chrome-'));
  const args = [
    `--user-data-dir=${profile}`,
    `--load-extension=${options.extensionPath}`,
    `--disable-extensions-except=${options.extensionPath}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    options.url,
  ];
  if (options.headless) args.unshift('--headless=new');
  if (process.getuid?.() === 0) args.unshift('--no-sandbox');
  const child = spawn(options.chromePath, args, { stdio: 'ignore', detached: false });
  child.unref();
  return child;
}

async function commandUp(argv: string[]): Promise<number> {
  const options = parseUpOptions(argv);
  const root = packageRoot();
  const handle = await startUp(options);
  const adminToken = ensureToken(options.dataDir);
  const agentToken = ensureAgentToken(options.dataDir);
  const dashboard = `${handle.url}/#token=${adminToken}`;

  out('');
  out('  UTCP Browser Session');
  out(`  runtime      ${handle.url}`);
  out(`  admin token  ${adminToken.slice(0, 8)}…   ${path.join(options.dataDir, 'runtime-token')}`);
  out(`  agent token  ${agentToken.slice(0, 8)}…   ${path.join(options.dataDir, 'agent-token')}`);
  out(`  dashboard    ${dashboard}`);
  if (handle.demo) {
    out(`  demo site    ${handle.demo.origin}   (alice / correct-horse)`);
  }
  out('');
  out(`  extension    ${extensionIdForPath(path.join(root, 'extension', 'dist'))}`);
  out('  next: the browser opens with the extension loaded and pairs itself.');
  if (handle.demo) {
    out('        sign in at the demo site, click around, then approve the draft tool');
    out('        in the dashboard. Nothing runs before you approve it.');
  }
  out('');

  if (options.browser) {
    const chrome = findChrome(options.chromePath);
    if (!chrome) {
      err('  no Chrome/Chromium found. Install one, or pass --chrome <path>.');
      if (!options.headless) err('  (the extension needs a real browser window)');
      await handle.stop();
      return EXIT.noBrowser;
    }
    if (!process.env.DISPLAY && !options.headless) {
      err('  no DISPLAY: launch Chrome with --headless (sign-in will not work) or run under xvfb-run.');
      await handle.stop();
      return EXIT.noBrowser;
    }
    launchChrome({
      chromePath: chrome,
      extensionPath: path.join(root, 'extension', 'dist'),
      url: dashboard,
      headless: options.headless,
    });
  } else {
    out('  browser not launched (--no-browser). Pair manually with: utcp-browser-session pair');
  }

  const shutdown = async (): Promise<void> => {
    out('\n  stopping…');
    await handle.stop();
    process.exit(EXIT.ok);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // Keep the process (and therefore the runtime) alive until interrupted.
  await new Promise<void>(() => undefined);
  return EXIT.ok;
}

async function commandDown(argv: string[]): Promise<number> {
  const dataDir = (() => {
    const index = argv.indexOf('--data-dir');
    return index >= 0 ? path.resolve(argv[index + 1]) : process.env.UBS_DATA_DIR ?? path.join(os.homedir(), '.utcp-browser-session');
  })();
  const state = readUpState(dataDir);
  if (!state) {
    out('  nothing to stop: no `up` state file for this data dir.');
    return EXIT.ok;
  }
  try {
    process.kill(state.pid, 'SIGTERM');
    out(`  stopped runtime pid ${state.pid} on port ${state.port}`);
  } catch {
    out(`  runtime pid ${state.pid} was not running`);
  }
  try {
    fs.rmSync(statePath(dataDir), { force: true });
  } catch {
    /* ignore */
  }
  return EXIT.ok;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    out(USAGE);
    return command ? EXIT.ok : EXIT.usage;
  }
  try {
    switch (command) {
      case 'up':
        return await commandUp(rest);
      case 'down':
        return await commandDown(rest);
      case 'serve':
        // Runtime only, manual pairing: the pre-`up` behaviour, kept for scripts.
        return await (await import('./index.ts')).runCommand('serve', rest);
      default: {
        // pair / status / tools / manual are handled by index.ts; keep one entry.
        const { runCommand } = await import('./index.ts');
        return await runCommand(command, rest);
      }
    }
  } catch (error) {
    if (error instanceof UsageError) {
      err(`  ${error.message}\n`);
      err(USAGE);
      return EXIT.usage;
    }
    const exitCode = (error as { exitCode?: number }).exitCode ?? EXIT.runtimeFailed;
    err(`  ${error instanceof Error ? error.message : String(error)}`);
    return exitCode;
  }
}

// Allow `node packages/runtime/src/cli.ts up` directly.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}

export { LIMITS };
