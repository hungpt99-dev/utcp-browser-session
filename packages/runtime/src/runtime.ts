/**
 * Programmatic entry point used by the CLI and by the test-suite.
 */
import { createRuntimeServer, type RuntimeServer } from './http.ts';
import { loadConfig, type RuntimeConfig } from './config.ts';
import { ExtensionHub } from './connections.ts';
import { Executor } from './executor.ts';
import { Logger, type LogLevel } from './logger.ts';
import { Store } from './store.ts';
import { ensureAgentToken, ensureToken } from './token.ts';

export interface RuntimeHandle {
  url: string;
  port: number;
  /** Admin credential: dashboard, CLI, approvals, pairing. */
  token: string;
  /** Execute-only credential: the one a UTCP client receives. */
  agentToken: string;
  config: RuntimeConfig;
  store: Store;
  hub: ExtensionHub;
  executor: Executor;
  server: RuntimeServer;
  close(): Promise<void>;
}

export interface CreateRuntimeOptions {
  port?: number;
  host?: string;
  dataDir?: string;
  token?: string;
  agentToken?: string;
  /** Offer the one-time auto-pair record over loopback (set by `up`). */
  autoPair?: boolean;
  dashboardDir?: string;
  logLevel?: LogLevel;
  quiet?: boolean;
}

export async function createRuntime(options: CreateRuntimeOptions = {}): Promise<RuntimeHandle> {
  const config = loadConfig({
    port: options.port,
    host: options.host,
    dataDir: options.dataDir,
    token: options.token,
    autoPair: options.autoPair,
    dashboardDir: options.dashboardDir,
    logLevel: options.logLevel,
  });

  const token = ensureToken(config.dataDir, config.token);
  const agentToken = ensureAgentToken(config.dataDir, options.agentToken);
  const store = Store.open(config.dataDir);
  const logger = new Logger(config.logLevel);
  const hub = new ExtensionHub(store, logger);
  const executor = new Executor(store, hub, logger);

  const server = createRuntimeServer({ config, store, hub, executor, logger, token, agentToken });
  const { port, url } = await server.start();
  // The config object is shared with the HTTP layer by reference, so updating it
  // here makes later manual generation use the real bound port (tests use 0).
  config.publicUrl = url;

  return {
    url: config.publicUrl,
    port,
    token,
    agentToken,
    config: { ...config },
    store,
    hub,
    executor,
    server,
    async close() {
      await hub.close();
      store.close();
      await server.stop();
    },
  };
}
