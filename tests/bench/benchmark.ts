/**
 * Performance benchmark.
 *
 * Compares, in the same browser and against the same fixture endpoint:
 *
 *   A. direct  — fetch() from the extension service worker (browser + network)
 *   B. utcp    — a real UtcpClient → provider → runtime → extension → website
 *
 * The difference is the UTCP stack's own overhead. Numbers are written to
 * docs/performance.json and printed as a table; nothing is estimated.
 *
 *   node tests/bench/benchmark.ts [--requests 200]
 */
import { chromium } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestSite } from '../../packages/test-site/src/server.ts';
import { createBrowserSessionClient } from '../../packages/provider/src/index.ts';
import { buildRequest, validateArguments } from '../../packages/shared/src/schema.ts';

const args = process.argv.slice(2);
const N = Number(args[args.indexOf('--requests') + 1]) || 200;
const PORT = Number(process.env.BENCH_PORT ?? 8791);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubs-bench-state-'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ubs-bench-profile-'));
const extensionPath = path.resolve('extension/dist');

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    p50: Number(percentile(sorted, 50).toFixed(2)),
    p95: Number(percentile(sorted, 95).toFixed(2)),
    p99: Number(percentile(sorted, 99).toFixed(2)),
    min: Number(sorted[0]?.toFixed(2) ?? 0),
    max: Number(sorted.at(-1)?.toFixed(2) ?? 0),
    mean: Number((sum / Math.max(sorted.length, 1)).toFixed(2)),
  };
}

async function waitForHealth(url: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('runtime did not start');
}

function rssMb(pid: number): number {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = /VmRSS:\s+(\d+) kB/.exec(status);
    return match ? Number((Number(match[1]) / 1024).toFixed(1)) : 0;
  } catch {
    return 0;
  }
}

const site = createTestSite({ port: 0 });
await site.start();

const runtimeUrl = `http://127.0.0.1:${PORT}`;
// Fail loudly instead of talking to a stale runtime left by an earlier run.
try {
  const existing = await fetch(`${runtimeUrl}/health`);
  if (existing.ok) throw new Error(`Port ${PORT} is already serving a runtime. Stop it (or set BENCH_PORT) and retry.`);
} catch (error) {
  if (error instanceof Error && error.message.startsWith('Port ')) throw error;
}

const runtime: ChildProcess = spawn(process.execPath, ['packages/runtime/src/index.ts', 'serve'], {
  env: { ...process.env, UBS_PORT: String(PORT), UBS_DATA_DIR: dataDir, UBS_LOG_LEVEL: 'error' },
  stdio: 'ignore',
  detached: false,
});
await waitForHealth(runtimeUrl);
const token = fs.readFileSync(path.join(dataDir, 'agent-token'), 'utf8').trim();
const api = async (pathname: string, init: RequestInit = {}) => {
  const response = await fetch(`${runtimeUrl}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  channel: 'chromium',
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-sandbox'],
});
let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
const extensionId = new URL(worker.url()).host;

// Pair + log in.
const popup = await context.newPage();
await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
await popup.waitForSelector('input[placeholder="ABCD-2345"]');
const { code } = (await api('/api/v1/pair/start', { method: 'POST' })).body;
await popup.getByLabel('Runtime address').fill(runtimeUrl);
await popup.getByLabel('Pairing code').fill(code);
await popup.getByRole('button', { name: 'Pair browser' }).click();
await popup.waitForTimeout(1200);
await popup.close();

const page = await context.newPage();
await page.goto(`${site.origin}/login`);
await page.fill('#username', 'alice');
await page.fill('#password', 'correct-horse');
await page.click('#login-submit');
await page.waitForURL('**/app');

const target = `${site.origin}/api/tasks?status=open&limit=10`;

// The default guard is 60 calls/minute per tool; a throughput benchmark needs
// headroom. 600/min is the maximum the runtime allows, and 200 samples fit.
await api('/api/v1/settings', { method: 'POST', body: JSON.stringify({ rateLimitPerMinute: 600 }) });

// Serve the tool from the real discovery path so the manual matches reality.
await api('/api/v1/domains', {
  method: 'POST',
  body: JSON.stringify({
    domain: site.origin,
    deepCapture: false,
    csrf: { bootstrapPath: '/api/csrf', tokenField: 'token', header: 'x-csrf-token' },
  }),
});
await api('/api/v1/domains/127.0.0.1/discovery', { method: 'POST' });
await page.click('#list-tasks');
await page.waitForTimeout(1200);
await api('/api/v1/domains/127.0.0.1/discovery', { method: 'DELETE' });
await api('/api/v1/tools/generate', { method: 'POST', body: JSON.stringify({ domain: '127.0.0.1' }) });
const tools = (await api('/api/v1/tools')).body.tools as Array<{ id: string; fqName: string; pathTemplate: string }>;
const readTool = tools.find((tool) => tool.pathTemplate === '/api/tasks');
if (!readTool) throw new Error('fixture tool was not generated');
await api(`/api/v1/tools/${readTool.id}/approve`, { method: 'POST' });

// ---------------------------------------------------------------- direct path
const directSamples = await worker.evaluate(
  async ({ url, count }) => {
    const samples: number[] = [];
    for (let index = 0; index < 20; index += 1) await fetch(url, { credentials: 'include' });
    for (let index = 0; index < count; index += 1) {
      const started = performance.now();
      const response = await fetch(url, { credentials: 'include' });
      await response.text();
      samples.push(performance.now() - started);
    }
    return samples;
  },
  { url: target, count: N },
);

// ----------------------------------------------------------------- utcp path
console.log('  hub:', JSON.stringify(await api('/api/v1/status').then((r) => r.body.connection)));
console.log('  ext:', JSON.stringify(await worker.evaluate(() => (self as any).__ubsDebug?.())));
const { client, manual } = await createBrowserSessionClient({ runtimeUrl, token });
if (!manual.success) throw new Error(`manual registration failed: ${manual.errors.join(', ')}`);

const utcpSamples: number[] = [];
let errors = 0;
for (let index = 0; index < 20; index += 1) await client.callTool(readTool.fqName, { status: 'open', limit: 10 });
for (let index = 0; index < N; index += 1) {
  const started = performance.now();
  try {
    const result = await client.callTool(readTool.fqName, { status: 'open', limit: 10 });
    if (!result.ok) errors += 1;
  } catch {
    errors += 1;
  }
  utcpSamples.push(performance.now() - started);
}

// ------------------------------------------------- schema validation overhead
const schema = { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'string' } }, required: [], additionalProperties: false };
const locations = { status: 'query' as const, limit: 'query' as const };
const validationStart = performance.now();
const iterations = 10_000;
for (let index = 0; index < iterations; index += 1) {
  const result = validateArguments(schema as never, { status: 'open', limit: 10 }, locations);
  buildRequest({ pathTemplate: '/api/tasks', method: 'GET', paramLocations: locations }, result.value);
}
const validationMs = performance.now() - validationStart;

const rssAfter = rssMb(runtime.pid!);
const direct = stats(directSamples);
const mediated = stats(utcpSamples);
const overheadP50 = Number((mediated.p50 - direct.p50).toFixed(2));
const durationMs = utcpSamples.reduce((total, value) => total + value, 0);

const report = {
  generatedAt: new Date().toISOString(),
  environment: {
    cpu: os.cpus()[0]?.model ?? 'unknown',
    cores: os.cpus().length,
    platform: `${os.platform()} ${os.release()}`,
    node: process.version,
    chrome: 'chromium (Playwright channel)',
    notes: 'All components on loopback; fixture site is a local Node HTTP server.',
  },
  samples: N,
  direct: direct,
  utcp: mediated,
  overhead: {
    p50Ms: overheadP50,
    ratioP50: Number((mediated.p50 / Math.max(direct.p50, 0.01)).toFixed(2)),
  },
  throughput: {
    utcpPerSecond: Number((1000 / Math.max(mediated.mean, 0.01)).toFixed(1)),
    measuredOverMs: Number(durationMs.toFixed(0)),
    errorRate: Number((errors / Math.max(utcpSamples.length, 1)).toFixed(4)),
  },
  schemaValidation: {
    iterations,
    totalMs: Number(validationMs.toFixed(1)),
    perCallUs: Number(((validationMs * 1000) / iterations).toFixed(1)),
  },
  memory: {
    runtimeRssMb: rssAfter,
    scope: 'RSS of the standalone runtime process after the run',
  },
  note: 'The per-tool rate limit was raised to its maximum of 600/min for this run; the shipped default is 60/min.',
};

fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync('docs/performance.json', `${JSON.stringify(report, null, 2)}\n`);

console.log(`\n  UTCP Browser Session benchmark — ${N} requests per path\n`);
console.log(`  direct browser fetch   p50 ${direct.p50} ms   p95 ${direct.p95} ms   p99 ${direct.p99} ms`);
console.log(`  via UTCP provider      p50 ${mediated.p50} ms   p95 ${mediated.p95} ms   p99 ${mediated.p99} ms`);
console.log(`  overhead               p50 +${overheadP50} ms (${report.overhead.ratioP50}x)`);
console.log(`  throughput             ${report.throughput.utcpPerSecond} calls/s, error rate ${(report.throughput.errorRate * 100).toFixed(2)}%`);
console.log(`  schema validation      ${report.schemaValidation.perCallUs} µs per validate+build`);
console.log(`  runtime RSS            ${report.memory.runtimeRssMb} MB\n`);

await context.close();
runtime.kill();
await site.stop();
fs.rmSync(dataDir, { recursive: true, force: true });
fs.rmSync(profile, { recursive: true, force: true });
process.exit(errors > 0 ? 1 : 0);
