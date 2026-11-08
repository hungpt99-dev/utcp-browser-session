import { redactValue, toErrorShape } from '@utcp-browser-session/shared';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

export type LogLevel = keyof typeof LEVELS;

/**
 * Structured logger.
 *
 * Everything written here passes through `redactValue`, so an accidental header
 * dump cannot turn into a credential leak in the console or a log file.
 */
export class Logger {
  private readonly level: LogLevel;

  constructor(level: LogLevel = 'info') {
    this.level = level;
  }

  child(): Logger {
    return this;
  }

  debug(event: string, detail?: Record<string, unknown>): void {
    this.write('debug', event, detail);
  }

  info(event: string, detail?: Record<string, unknown>): void {
    this.write('info', event, detail);
  }

  warn(event: string, detail?: Record<string, unknown>): void {
    this.write('warn', event, detail);
  }

  error(event: string, detail?: Record<string, unknown> | unknown): void {
    const normalized =
      detail instanceof Error || (typeof detail === 'object' && detail !== null && 'code' in (detail as object))
        ? { error: toErrorShape(detail) }
        : (detail as Record<string, unknown> | undefined);
    this.write('error', event, normalized);
  }

  private write(level: LogLevel, event: string, detail?: Record<string, unknown>): void {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const line: Record<string, unknown> = { ts: new Date().toISOString(), level, event };
    if (detail) line.detail = redactValue(detail);
    process.stderr.write(`${JSON.stringify(line)}\n`);
  }
}
