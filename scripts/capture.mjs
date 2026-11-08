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
// Auto-pairing needs the address the extension already knows about (8777).
const runtime = await createRuntime({
  port: Number(process.env.UBS_CAPTURE_PORT ?? 8777),
  dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ubs-shot-state-')),
  logLevel: 'error',
  // Screenshots follow the new first-run flow: no pairing code is typed.
  autoPair: true,
});

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

// --- 1. the popup, already paired by the auto-pair record -------------------
runtime.store.createAutoPair(120_000, extensionId);
const popup = await context.newPage();
await popup.setViewportSize({ width: 392, height: 620 });
await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
// The extension pairs itself on startup; the popup just reflects it.
await popup.getByText('Connected', { exact: true }).waitFor({ timeout: 30_000 });
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

// --- 11. MP4 + poster from the recorded session ---------------------------
// A 4 MB GIF is a bad first impression on a slow connection; an H.264 MP4 with
// a poster is ~10x smaller and starts instantly in the README.
const video = fs.readdirSync(videoDir).find((file) => file.endsWith('.webm'));
if (video) {
  const input = path.join(videoDir, video);
  console.log(`  source video: ${video} (${(fs.statSync(input).size / 1024 / 1024).toFixed(2)} MB)`);
  const mp4 = path.join(shots, 'demo.mp4');
  const poster = path.join(shots, 'demo-poster.png');
  execFileSync(
    'ffmpeg',
    [
      '-y', '-t', '34', '-i', input,
      '-vf', 'scale=1280:-2:flags=lanczos,fps=24',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '30',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an',
      mp4,
    ],
    { stdio: 'inherit' },
  );
  execFileSync('ffmpeg', ['-y', '-ss', '6', '-i', mp4, '-frames:v', '1', poster], { stdio: 'inherit' });
  console.log(`  captured demo.mp4 (${(fs.statSync(mp4).size / 1024 / 1024).toFixed(2)} MB) + poster`);
  for (const stale of ['demo.gif']) {
    const file = path.join(shots, stale);
    if (fs.existsSync(file)) {
      fs.rmSync(file);
      console.log(`  removed ${stale}`);
    }
  }
}
fs.rmSync(videoDir, { recursive: true, force: true });
process.exit(0);
