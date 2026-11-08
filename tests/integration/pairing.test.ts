import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, type Harness } from '../helpers/harness.ts';
import { FakeExtension } from '../helpers/fake-extension.ts';

describe('pairing endpoint', () => {
  let harness: Harness;

  before(async () => {
    harness = await createHarness();
  });
  after(async () => {
    await harness.close();
  });

  it('requires the runtime token to mint a pairing code', async () => {
    const response = await fetch(`${harness.runtime.url}/api/v1/pair/start`, { method: 'POST' });
    assert.equal(response.status, 401);
  });

  it('rejects a claim that does not come from an extension origin', async () => {
    const { code } = (await harness.api('/api/v1/pair/start', { method: 'POST' })).body;
    const response = await fetch(`${harness.runtime.url}/api/v1/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ code, extensionId: 'abcdefghijklmnopabcdefghijklmnop', publicKeyJwk: jwkPlaceholder() }),
    });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.error, 'origin_not_allowed');
  });

  it('rejects a claim whose extensionId does not match the origin', async () => {
    const { code } = (await harness.api('/api/v1/pair/start', { method: 'POST' })).body;
    const response = await fetch(`${harness.runtime.url}/api/v1/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba' },
      body: JSON.stringify({ code, extensionId: 'abcdefghijklmnopabcdefghijklmnop', publicKeyJwk: jwkPlaceholder() }),
    });
    assert.equal(response.status, 403);
  });

  it('issues a client id for a valid code and never returns a secret', async () => {
    const extension = await FakeExtension.pair({ runtimeUrl: harness.runtime.url, token: harness.runtime.token });
    assert.match(extension.clientId, /^ext_/);
    const client = harness.runtime.store.getClient(extension.clientId);
    assert.ok(client);
    assert.equal((client as unknown as Record<string, unknown>).secret, undefined);
    assert.equal((client as unknown as Record<string, unknown>).privateKeyJwk, undefined);
    assert.ok(client?.publicKeyJwk.x);
  });

  it('refuses to reuse a pairing code', async () => {
    const start = await harness.api('/api/v1/pair/start', { method: 'POST' });
    const code = start.body.code as string;
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const claim = (body: unknown) =>
      fetch(`${harness.runtime.url}/api/v1/pair/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' },
        body: JSON.stringify(body),
      });

    const payload = {
      code,
      extensionId: 'abcdefghijklmnopabcdefghijklmnop',
      publicKeyJwk: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y },
    };
    assert.equal((await claim(payload)).status, 201);
    const second = await claim(payload);
    assert.equal(second.status, 400);
    assert.equal((await second.json()).error, 'pairing_invalid');
  });

  it('rejects an expired pairing code', async () => {
    const code = harness.runtime.store.createPairingCode(-1000).code;
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const response = await fetch(`${harness.runtime.url}/api/v1/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' },
      body: JSON.stringify({
        code,
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        publicKeyJwk: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y },
      }),
    });
    assert.equal(response.status, 400);
  });
});

describe('extension handshake', () => {
  let harness: Harness;

  before(async () => {
    harness = await createHarness();
  });
  after(async () => {
    await harness.close();
  });

  it('accepts a correctly signed hello and pushes the domain allowlist', async () => {
    const extension = await FakeExtension.pair({ runtimeUrl: harness.runtime.url, token: harness.runtime.token });
    await extension.connect();
    await extension.waitForSync();
    assert.equal(harness.runtime.hub.status().connected, true);
    assert.equal(harness.runtime.hub.status().client?.clientId, extension.clientId);
    extension.close();
  });

  it('rejects a bad signature', async () => {
    const extension = await FakeExtension.pair({ runtimeUrl: harness.runtime.url, token: harness.runtime.token });
    extension.expectRejection = true;
    extension.tamper = { signature: Buffer.alloc(64, 7).toString('base64url') };
    await extension.connect();
    assert.notEqual(harness.runtime.hub.status().client?.clientId, extension.clientId);
  });

  it('rejects a stale timestamp', async () => {
    const extension = await FakeExtension.pair({ runtimeUrl: harness.runtime.url, token: harness.runtime.token });
    extension.expectRejection = true;
    extension.tamper = { ts: Date.now() - 10 * 60_000 };
    await extension.connect();
    assert.equal(harness.runtime.hub.status().connected, false);
  });

  it('rejects an unknown nonce (replay of another connection)', async () => {
    const extension = await FakeExtension.pair({ runtimeUrl: harness.runtime.url, token: harness.runtime.token });
    extension.expectRejection = true;
    extension.tamper = { nonce: 'bm90LXRoZS1ub25jZQ' };
    await extension.connect();
    assert.equal(harness.runtime.hub.status().connected, false);
  });

  it('rejects a handshake from a non-extension origin', async () => {
    const extension = await FakeExtension.pair({ runtimeUrl: harness.runtime.url, token: harness.runtime.token });
    extension.expectRejection = true;
    extension.tamper = { origin: 'https://evil.example' };
    await extension.connect();
    assert.equal(harness.runtime.hub.status().connected, false);
  });

  it('rejects a revoked client', async () => {
    const extension = await FakeExtension.pair({ runtimeUrl: harness.runtime.url, token: harness.runtime.token });
    harness.runtime.store.revokeClient(extension.clientId);
    extension.expectRejection = true;
    await extension.connect();
    assert.equal(harness.runtime.hub.status().connected, false);
  });

  it('drops pending executions when the browser disconnects', async () => {
    const extension = await FakeExtension.pair({ runtimeUrl: harness.runtime.url, token: harness.runtime.token });
    await extension.connect();
    await extension.waitForSync();
    extension.onExecute(async () => {
      extension.close();
      return { type: 'result', id: '', ok: true, status: 200, headers: {}, body: '{}', latencyMs: 1, truncated: false, bodyEncoding: 'utf8' };
    });
    harness.runtime.store.enableDomain('http://127.0.0.1:1', '127.0.0.1');
    const endpoint = harness.runtime.store.recordObservation({
      origin: 'http://127.0.0.1:1',
      method: 'GET',
      path: '/api/x',
      queryKeys: [],
      source: 'webRequest',
    });
    const tool = harness.runtime.store.generateDrafts('http://127.0.0.1:1').created[0];
    harness.runtime.store.approveTool(tool.id, 'test');

    const envelope = await harness.runtime.executor.execute({ tool: tool.fqName, args: {}, confirm: false, actor: 'utcp' });
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error?.code, 'extension_disconnected');
    assert.ok(endpoint);
  });
});

function jwkPlaceholder(): { kty: 'EC'; crv: 'P-256'; x: string; y: string } {
  return { kty: 'EC', crv: 'P-256', x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', y: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' };
}
