#!/usr/bin/env node
/**
 * Captures the README screenshots and the demo GIF from a real run.
 *
 * Everything here is driven through the actual UI: the extension popup, the
 * dashboard served by the runtime, and the fixture website. No mock screens.
 *
 *   xvfb-run -a node scripts/capture.mjs
 */
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestSite } from '../packages/test-site/src/server.ts';
import { createRuntime } from '../packages/runtime/src/runtime.ts';
import { createBrowserSessionClient } from '../packages/provider/src/index.ts';

const root = path.resolve('.');
const shots = path.join(root, 'docs/screenshots');
const videoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubs-video-'));
fs.mkdirSync(shots, { recursive: true });

const site = createTestSite({ port: 0 });
await site.start();
const runtime = await createRuntime({ port: 0, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ubs-shot-state-')), logLevel: 'error' });

const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'ubs-shot-profile-')), {
  headless: false,
  channel: 'chromium',
  viewport: { width: 1360, height: 880 },
  deviceScaleFactor: 2,
  recordVideo: { dir: videoDir, size: { width: 1360, height: 880 } },
  args: [`--disable-extensions-except=${path.join(root, 'extension/dist')}`, `--load-extension=${path.join(root, 'extension/dist')}`, '--no-sandbox'],
});

let [worker] = context.serviceWorkers();
if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
const extensionId = new URL(worker.url()).host;

const api = async (pathname, init = {}) => {
  const response = await fetch(`${runtime.url}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${runtime.token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

async function nav(page, name) {
  // Any open drawer has a modal backdrop; Escape closes it before navigating.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await page.getByRole('button', { name }).click();
  await page.waitForTimeout(700);
}

const pause = (ms = 650) => new Promise((resolve) => setTimeout(resolve, ms));
async function shot(page, name) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, name), fullPage: false });
  console.log(`  captured ${name}`);
}

// --- 1. pair through the popup ---------------------------------------------
const popup = await context.newPage();
await popup.setViewportSize({ width: 392, height: 620 });
await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
await popup.waitForSelector('input[placeholder="ABCD-2345"]');
const { code } = (await api('/api/v1/pair/start', { method: 'POST' })).body;
await popup.getByLabel('Runtime address').fill(runtime.url);
await popup.getByLabel('Pairing code').fill(code);
await popup.getByRole('button', { name: 'Pair browser' }).click();
await popup.getByText('Connected', { exact: true }).waitFor();
await pause(900);

// --- 2. sign in to the fixture site ----------------------------------------
const app = await context.newPage();
await app.setViewportSize({ width: 1360, height: 880 });
await app.goto(`${site.origin}/login`);
await app.fill('#username', 'alice');
await app.fill('#password', 'correct-horse');
await app.click('#login-submit');
await app.waitForURL('**/app');

// --- 3. dashboard: enable the site through the form ------------------------
const dash = await context.newPage();
await dash.setViewportSize({ width: 1360, height: 880 });
await dash.goto(`${runtime.url}/?token=${runtime.token}`);
await dash.getByRole('heading', { name: 'Overview' }).waitFor();
await pause(1200);

await dash.getByRole('button', { name: 'Websites' }).click();
await dash.getByLabel('Site URL or hostname').fill(site.origin);await dash.getByLabel('CSRF bootstrap path (optional)').fill('/api/csrf');
await dash.getByRole('button', { name: 'Enable' }).click();
await dash.getByText('Domain enabled. Start discovery').waitFor();
await dash.getByRole('button', { name: 'Start discovery' }).click();
await pause(800);

// --- 4. browse the site so discovery has something to record ---------------
await app.bringToFront();
for (const id of ['#list-tasks', '#create-task', '#get-task', '#project-summary', '#delete-task']) {
  await app.click(id);
  await pause(650);
}

// --- 5. websites view with the discovered endpoints ------------------------
await dash.bringToFront();
await dash.waitForTimeout(2500);
await dash.getByRole('button', { name: 'Generate drafts' }).first().waitFor();
await dash.getByRole('button', { name: 'Show endpoints' }).first().click();
await pause(900);
await shot(dash, '03-websites-discovery.png');

// --- 6. draft tools and the approval inspector ----------------------------
await dash.getByRole('button', { name: 'Generate drafts' }).first().click();
await pause(900);
await nav(dash, 'Tools');
await dash.getByText('browser.create_task').first().click();
await pause(900);
await shot(dash, '04-tool-approval.png');

// --- 7. approve and execute from the inspector ----------------------------
await dash.getByRole('button', { name: 'Approve tool' }).click();
await dash.getByRole('tab', { name: 'Test call' }).click();
await dash.getByLabel('Arguments (JSON)').fill(
  JSON.stringify({ title: 'Filed from the tool inspector', description: 'Created through the dashboard', priority: 2 }, null, 2),
);
await dash.getByRole('button', { name: /Execute through the browser/ }).click();
await dash.getByText('executionId').first().waitFor({ timeout: 15_000 });
await pause(900);
await shot(dash, '05-tool-execution.png');

// --- 8. execution inspector ----------------------------------------------
await nav(dash, 'Executions');
await dash.waitForTimeout(700);
await dash.locator('tbody tr').first().click();
await pause(900);
await shot(dash, '06-execution-inspector.png');

// --- 9. security center --------------------------------------------------
await nav(dash, 'Security');
await dash.waitForTimeout(900);
await shot(dash, '07-security-center.png');

// --- 10. overview with real activity (hero shot) -------------------------
await nav(dash, 'Overview');
await dash.waitForTimeout(1500);
await shot(dash, '02-dashboard-overview.png');

// --- 11. popup with an approved domain -----------------------------------
const { client } = await createBrowserSessionClient({ runtimeUrl: runtime.url, token: runtime.token });
await client.callTool('browser.list_tasks', { status: 'open', limit: 10 }).catch(() => undefined);
await popup.bringToFront();
await popup.reload();
await popup.getByText('Approved domains').waitFor();
await pause(900);
await shot(popup, '01-extension-popup.png');

await context.close();
await runtime.close();
await site.stop();

// --- 11. GIF from the recorded session ------------------------------------
const video = fs.readdirSync(videoDir).find((file) => file.endsWith('.webm'));
if (video) {
  const input = path.join(videoDir, video);
  console.log(`  source video: ${video} (${(fs.statSync(input).size / 1024 / 1024).toFixed(2)} MB)`);
  const gif = path.join(shots, 'demo.gif');
  const palette = path.join(videoDir, 'palette.png');
  execFileSync('ffmpeg', ['-y', '-t', '34', '-i', input, '-vf', 'fps=6,scale=840:-1:flags=lanczos,palettegen=max_colors=96:stats_mode=diff', palette], { stdio: 'inherit' });
  execFileSync(
    'ffmpeg',
    ['-y', '-t', '34', '-i', input, '-i', palette, '-filter_complex', 'fps=6,scale=840:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=none', '-loop', '0', gif],
    { stdio: 'inherit' },
  );
  console.log(`  captured demo.gif (${(fs.statSync(gif).size / 1024 / 1024).toFixed(2)} MB)`);
}
fs.rmSync(videoDir, { recursive: true, force: true });
process.exit(0);
