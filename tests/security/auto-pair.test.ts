/**
 * Auto-pairing must be a convenience, not a hole.
 *
 * The record is one-time, short-lived, bound to the extension `up` launched and
 * only present while the runtime runs with `--auto-pair`. The ECDSA exchange is
 * unchanged: the code is a claim ticket, and the signed handshake still has to
 * succeed before any frame is accepted.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntime, type RuntimeHandle } from '../../packages/runtime/src/runtime.ts';
import { extensionIdForPath } from '../../packages/shared/src/extension-id.ts';

const EXT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
let dataDir = '';

function autoPair(runtime: RuntimeHandle, extensionId: string) {
  return fetch(`${runtime.url}/api/v1/pair/auto`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `chrome-extension://${extensionId}` },
    body: '{}',
  });
}

describe('auto-pairing', () => {
  let runtime: RuntimeHandle;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubs-autopair-'));
    runtime = await createRuntime({ port: 0, dataDir, autoPair: true, logLevel: 'error' });
  });

  after(async () => {
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('is off unless the runtime was started with it', async () => {
    const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubs-autopair-off-'));
    const plain = await createRuntime({ port: 0, dataDir: plainDir, logLevel: 'error' });
    const response = await autoPair(plain, EXT);
    assert.equal(response.status, 404, 'a plain `serve` does not hand out codes');
    await plain.close();
    fs.rmSync(plainDir, { recursive: true, force: true });
  });

  it('refuses a request that is not from an extension origin', async () => {
    runtime.store.createAutoPair(60_000);
    const response = await fetch(`${runtime.url}/api/v1/pair/auto`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
      body: '{}',
    });
    assert.equal(response.status, 403);
    assert.equal(runtime.store.hasAutoPair, true, 'a rejected probe does not consume the record');
  });

  it('hands the code out exactly once', async () => {
    runtime.store.createAutoPair(60_000);
    const first = await autoPair(runtime, EXT);
    assert.equal(first.status, 200);
    const body = (await first.json()) as { code: string; expiresAt: string };
    assert.match(body.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const replay = await autoPair(runtime, EXT);
    assert.equal(replay.status, 410, 'a replayed read fails closed');
  });

  it('refuses an extension other than the one it was created for', async () => {
    runtime.store.createAutoPair(60_000, EXT);
    const foreign = await autoPair(runtime, OTHER);
    assert.equal(foreign.status, 410);
    // The correct extension can still take it.
    assert.equal((await autoPair(runtime, EXT)).status, 200);
  });

  it('fails closed once expired', async () => {
    runtime.store.createAutoPair(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(runtime.store.hasAutoPair, false);
    assert.equal((await autoPair(runtime, EXT)).status, 410);
  });

  it('derives the same extension id Chrome does', () => {
    // Verified against a real unpacked load: sha256(path) -> first 16 bytes,
    // each nibble mapped to a-p.
    assert.equal(extensionIdForPath('/root/utcp-browser-session/extension/dist'), 'nonhmljobkjipbeipekeiadlgamimjde');
    assert.match(extensionIdForPath('/tmp/some/other/path'), /^[a-p]{32}$/);
    assert.notEqual(extensionIdForPath('/tmp/a'), extensionIdForPath('/tmp/b'));
  });

  it('audits both the issue and the refusal', async () => {
    runtime.store.createAutoPair(60_000, EXT);
    await autoPair(runtime, OTHER);
    await autoPair(runtime, EXT);
    const kinds = runtime.store.listAudit(20).map((event) => event.kind);
    assert.ok(kinds.includes('pair.auto_rejected'));
    assert.ok(kinds.includes('pair.auto_issued'));
  });
});
