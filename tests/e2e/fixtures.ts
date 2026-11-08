/**
 * Shared E2E world: a real Chromium profile with the unpacked extension, the
 * fixture website and a live runtime. Nothing here is mocked.
 */
import { test as base, chromium, type BrowserContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime, type RuntimeHandle } from '../../packages/runtime/src/runtime.ts';
import { createTestSite, type TestSite } from '../../packages/test-site/src/server.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(here, '../../extension/dist');

export interface World {
  site: TestSite;
  runtime: RuntimeHandle;
  context: BrowserContext;
  extensionId: string;
  serviceWorker: import('@playwright/test').Worker;
  /** Pair the extension through its real popup UI. */
  pair(page?: Page): Promise<Page>;
  /** Sign in to the fixture site in a real tab. */
  login(): Promise<Page>;
  enableDomain(options?: { deepCapture?: boolean; csrf?: boolean }): Promise<void>;
  startDiscovery(): Promise<void>;
  stopDiscovery(): Promise<void>;
  /** Generate drafts for every discovered endpoint and approve all of them. */
  generateAndApprove(): Promise<Array<{ id: string; fqName: string; permission: string; method: string; pathTemplate: string }>>;
  api<T = any>(pathname: string, init?: RequestInit): Promise<{ status: number; body: T }>;
  popup(): Promise<Page>;
}

export const test = base.extend<{}, { world: World }>({
  world: [
    async ({}, use) => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubs-e2e-state-'));
      const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ubs-e2e-profile-'));

      const site = createTestSite({ port: 0 });
      await site.start();
      const runtime = await createRuntime({ port: 0, dataDir, logLevel: 'warn' });

      const context = await chromium.launchPersistentContext(profile, {
        headless: false,
        channel: 'chromium',
        viewport: { width: 1440, height: 900 },
        args: [
          `--disable-extensions-except=${EXTENSION_PATH}`,
          `--load-extension=${EXTENSION_PATH}`,
          '--no-sandbox',
          '--disable-dev-shm-usage',
        ],
      });

      let [serviceWorker] = context.serviceWorkers();
      if (!serviceWorker) serviceWorker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
      const extensionId = new URL(serviceWorker.url()).host;

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

      const world: World = {
        site,
        runtime,
        context,
        extensionId,
        serviceWorker,
        api,
        async popup() {
          const page = await context.newPage();
          await page.goto(`chrome-extension://${extensionId}/popup/index.html`);
          await page.getByText('UTCP Browser Session').waitFor({ timeout: 15_000 });
          return page;
        },
        async pair(existing) {
          const page = existing ?? (await world.popup());
          // The world is worker-scoped, so a later spec may find the browser
          // already paired; in that case only the socket needs repairing.
          if ((await page.locator('input[placeholder="ABCD-2345"]').count()) === 0) {
            await page.getByRole('button', { name: 'Reconnect' }).click({ timeout: 5_000 }).catch(() => undefined);
            await page.getByText('Connected', { exact: true }).waitFor({ timeout: 20_000 });
            return page;
          }
          await page.waitForSelector('input[placeholder="ABCD-2345"]', { timeout: 20_000 });
          const { code } = (await api<{ code: string }>('/api/v1/pair/start', { method: 'POST' })).body;
          await page.getByLabel('Runtime address').fill(runtime.url);
          await page.getByLabel('Pairing code').fill(code);
          await page.getByRole('button', { name: 'Pair browser' }).click();
          await page.getByText('Paired. The runtime now shows this browser as connected.').waitFor({ timeout: 15_000 });
          return page;
        },
        async login() {
          const page = await context.newPage();
          await page.goto(`${site.origin}/login`);
          await page.fill('#username', 'alice');
          await page.fill('#password', 'correct-horse');
          await page.click('#login-submit');
          await page.waitForURL('**/app');
          return page;
        },
        async enableDomain(options = {}) {
          await api('/api/v1/domains', {
            method: 'POST',
            body: JSON.stringify({
              domain: site.origin,
              deepCapture: options.deepCapture ?? true,
              ...(options.csrf === false
                ? {}
                : { csrf: { bootstrapPath: '/api/csrf', tokenField: 'token', header: 'x-csrf-token' } }),
            }),
          });
        },
        async startDiscovery() {
          const result = await api(`/api/v1/domains/${encodeURIComponent(site.origin)}/discovery`, { method: 'POST' });
          if (result.status !== 200) throw new Error(`discovery start failed: ${JSON.stringify(result.body)}`);
          // Wait until the extension has acknowledged capture, the same state the
          // dashboard shows, so the clicks below are guaranteed to be observed.
          for (let attempt = 0; attempt < 50; attempt += 1) {
            const status = await api<{ connection: { capturing: string[] } }>('/api/v1/status');
            if (status.body.connection.capturing.includes(site.origin)) return;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          throw new Error('the extension never acknowledged discovery capture');
        },
        async stopDiscovery() {
          await api(`/api/v1/domains/${encodeURIComponent(site.origin)}/discovery`, { method: 'DELETE' });
        },
        async generateAndApprove() {
          await api('/api/v1/tools/generate', { method: 'POST', body: JSON.stringify({ origin: site.origin }) });
          const tools = (await api<{ tools: any[] }>('/api/v1/tools')).body.tools;
          for (const tool of tools) {
            if (tool.status !== 'approved') await api(`/api/v1/tools/${tool.id}/approve`, { method: 'POST' });
          }
          return (await api<{ tools: any[] }>('/api/v1/tools')).body.tools;
        },
      };

      await use(world);
      await context.close();
      await runtime.close();
      await site.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(profile, { recursive: true, force: true });
    },
    { scope: 'worker' },
  ],
});

export { expect } from '@playwright/test';
