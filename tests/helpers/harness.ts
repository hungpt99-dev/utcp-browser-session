/**
 * Test harness: a real runtime, a real fixture site, and a temp state dir.
 * Nothing is mocked except the browser itself.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntime, type RuntimeHandle } from '../../packages/runtime/src/runtime.ts';
import { createTestSite, type TestSite } from '../../packages/test-site/src/server.ts';

export interface Harness {
  site: TestSite;
  runtime: RuntimeHandle;
  dataDir: string;
  api<T = any>(pathname: string, init?: RequestInit & { raw?: boolean }): Promise<{ status: number; body: T }>;
  close(): Promise<void>;
}

export async function createHarness(options: { sitePort?: number; logLevel?: 'error' | 'warn' } = {}): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubs-test-'));
  const site = createTestSite({ port: options.sitePort ?? 0 });
  await site.start();
  const runtime = await createRuntime({ port: 0, dataDir, logLevel: options.logLevel ?? 'error' });

  const api = async <T = any>(pathname: string, init: RequestInit = {}) => {
    const response = await fetch(`${runtime.url}${pathname}`, {
      ...init,
      headers: {
        authorization: `Bearer ${runtime.token}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
  };

  return {
    site,
    runtime,
    dataDir,
    api,
    async close() {
      await runtime.close();
      await site.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Enable the fixture domain with schema capture and CSRF bootstrap configured. */
export async function enableFixtureDomain(harness: Harness): Promise<void> {
  const result = await harness.api('/api/v1/domains', {
    method: 'POST',
    body: JSON.stringify({
      domain: harness.site.origin,
      deepCapture: true,
      csrf: { bootstrapPath: '/api/csrf', tokenField: 'token', header: 'x-csrf-token' },
    }),
  });
  if (result.status !== 201) throw new Error(`enableFixtureDomain failed: ${JSON.stringify(result.body)}`);
}

export function readState(dataDir: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
}
