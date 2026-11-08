import path from 'node:path';
import os from 'node:os';
import { LIMITS } from '@utcp-browser-session/shared';

export interface RuntimeConfig {
  host: string;
  port: number;
  dataDir: string;
  dashboardDir: string;
  /** Bearer token accepted from local clients (dashboard, CLI, provider). */
  token: string | null;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Public base URL used when the runtime builds its own links. */
  publicUrl: string;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

/** Repository root, resolved from this file so it works from any cwd. */
export function repoRoot(): string {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
}

export function loadConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  const env = process.env;
  const dataDir = overrides.dataDir ?? env.UBS_DATA_DIR ?? path.join(os.homedir(), '.utcp-browser-session');
  const port = overrides.port ?? Number(env.UBS_PORT ?? 8777);
  const host = overrides.host ?? env.UBS_HOST ?? '127.0.0.1';

  return {
    host,
    port,
    dataDir,
    dashboardDir: overrides.dashboardDir ?? env.UBS_DASHBOARD_DIR ?? path.join(repoRoot(), 'dashboard', 'dist'),
    token: overrides.token ?? env.UBS_TOKEN ?? null,
    logLevel: (overrides.logLevel ?? (env.UBS_LOG_LEVEL as RuntimeConfig['logLevel']) ?? 'info'),
    publicUrl: overrides.publicUrl ?? env.UBS_PUBLIC_URL ?? `http://${host}:${port}`,
  };
}

export const RUNTIME_DEFAULTS = {
  defaultTimeoutMs: LIMITS.defaultTimeoutMs,
  maxResponseBytes: LIMITS.maxResponseBytes,
  rateLimitPerMinute: LIMITS.rateLimitPerMinute,
  maxInFlight: LIMITS.maxInFlight,
  maxQueue: LIMITS.maxQueue,
  allowHttpLocalhost: true,
} as const;

export function envFlag(name: string, fallback = false): boolean {
  return bool(process.env[name], fallback);
}
