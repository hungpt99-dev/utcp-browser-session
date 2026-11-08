/**
 * First-run acceptance: `up --demo` → sign in → approve → call.
 *
 * This is the whole point of the change set: no `chrome://extensions`, no
 * pairing code, no dashboard typing. The browser is launched the way `up`
 * launches it (unpacked extension, isolated profile) and pairs itself through
 * the runtime's one-time auto-pair record.
 */
import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startUp, type UpHandle } from '../../packages/runtime/src/cli.ts';
import { createBrowserSessionClient } from '../../packages/provider/src/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(here, '../../extension/dist');
// Auto-pairing needs the default address, which is exactly what `up` uses.
const PORT = 8777;

test.describe.configure({ mode: 'serial' });

test('up --demo reaches a tool call with no manual pairing', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubs-firstrun-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ubs-firstrun-profile-'));
  let up: UpHandle | null = null;
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | null = null;

  try {
    up = await startUp({ demo: true, port: PORT, dataDir, browser: false, chromePath: null, headless: false });

    // 1. The browser comes up with the extension already loaded.
    context = await chromium.launchPersistentContext(profile, {
      headless: false,
      channel: 'chromium',
      viewport: { width: 1280, height: 860 },
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    });
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });

    // 2. Pairing happens without a human: the extension fetches the record.
    await expect
      .poll(() => up!.runtime.hub.isConnected, { timeout: 30_000, intervals: [250, 500, 1000] })
      .toBe(true);
    const audit = await fetch(`${up.url}/api/v1/audit?limit=20`, {
      headers: { authorization: `Bearer ${fs.readFileSync(path.join(dataDir, 'runtime-token'), 'utf8').trim()}` },
    }).then((response) => response.json());
    const kinds = audit.events.map((event: { kind: string }) => event.kind);
    expect(kinds).toContain('pair.auto_issued');
    expect(kinds).toContain('pair.claimed');

    // 3. Sign in to the demo site and use it, so discovery sees the API.
    const page = await context.newPage();
    await page.goto(`${up.demo!.origin}/login`);
    await page.fill('#username', 'alice');
    await page.fill('#password', 'correct-horse');
    await page.click('#login-submit');
    await page.waitForURL('**/app');
    await page.waitForTimeout(400);
    await page.click('#list-tasks');
    await page.waitForTimeout(300);
    await page.click('#create-task');

    // 4. Drafts appear without touching the dashboard (approval is still human).
    const adminToken = fs.readFileSync(path.join(dataDir, 'runtime-token'), 'utf8').trim();
    await expect
      .poll(
        async () => {
          const listing = await fetch(`${up!.url}/api/v1/tools?status=draft`, {
            headers: { authorization: `Bearer ${adminToken}` },
          }).then((response) => response.json());
          return listing.tools.find((tool: { method: string; pathTemplate: string }) => tool.method === 'POST' && tool.pathTemplate === '/api/tasks')?.id ?? null;
        },
        { timeout: 20_000, intervals: [500, 1000] },
      )
      .not.toBeNull();

    const drafts = await fetch(`${up.url}/api/v1/tools?status=draft`, {
      headers: { authorization: `Bearer ${adminToken}` },
    }).then((response) => response.json());
    const createTool = drafts.tools.find(
      (tool: { method: string; pathTemplate: string }) => tool.method === 'POST' && tool.pathTemplate === '/api/tasks',
    );

    // 5. A draft is not callable before approval.
    const agentToken = fs.readFileSync(path.join(dataDir, 'agent-token'), 'utf8').trim();
    const { client } = await createBrowserSessionClient({ runtimeUrl: up.url, token: agentToken });
    const refused = await client
      .callTool(createTool.fqName, { title: 'should not run', priority: 2 })
      .catch((error: Error & { code?: string; details?: unknown }) => ({
        ok: false,
        code: error.code ?? null,
        message: error.message,
      }));
    // A draft is invisible to the manual, so the client cannot even see it —
    // which is the strongest form of "not executable yet".
    expect(JSON.stringify(refused)).toMatch(/not found|approval_required|still a draft|tool_not_approved/i);

    // 6. Approve (the one remaining human action) and call it.
    const approved = await fetch(`${up.url}/api/v1/tools/${createTool.id}/approve`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(approved.status).toBe(200);

    // The manual was fetched before approval, so re-register it to pick the tool up.
    const approvedClient = (await createBrowserSessionClient({ runtimeUrl: up.url, token: agentToken })).client;
    const result = (await approvedClient.callTool(createTool.fqName, { title: 'first run probe', priority: 2 })) as {
      ok: boolean;
      body: { created: boolean; task: { title: string; owner: string } };
    };
    expect(result.ok).toBe(true);
    expect(result.body.created).toBe(true);
    expect(result.body.task.title).toBe('first run probe');

    // 7. The second call of the same auto-pair record must not exist any more.
    const replay = await fetch(`${up.url}/api/v1/pair/auto`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `chrome-extension://${new URL(worker.url()).host}` },
      body: '{}',
    });
    expect(replay.status).toBe(410);
    // And without the extension origin it is not even reachable.
    const foreign = await fetch(`${up.url}/api/v1/pair/auto`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
      body: '{}',
    });
    expect(foreign.status).toBe(403);
  } finally {
    await context?.close().catch(() => undefined);
    await up?.stop().catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
