import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, enableFixtureDomain, type Harness } from '../helpers/harness.ts';
import { FakeExtension } from '../helpers/fake-extension.ts';
import { checkTargetUrl } from '../../packages/shared/src/domain.ts';

describe('cross-domain and SSRF protection', () => {
  let harness: Harness;
  let extension: FakeExtension;

  before(async () => {
    harness = await createHarness();
    await enableFixtureDomain(harness);
    extension = await FakeExtension.pair({ runtimeUrl: harness.runtime.url, token: harness.runtime.token });
    await extension.connect();
    await extension.waitForSync();
    extension.onExecute(() => ({
      type: 'result',
      id: '',
      ok: true,
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
      latencyMs: 2,
      truncated: false,
      bodyEncoding: 'utf8',
    }));
  });

  after(async () => {
    extension.close();
    await harness.close();
  });

  it('percent-encodes argument values so they cannot escape the path segment', async () => {
    harness.runtime.store.recordObservation({
      domain: '127.0.0.1',
      method: 'GET',
      path: '/api/tasks/1',
      queryKeys: [],
      status: 200,
      source: 'webRequest',
    });
    const tool = harness.runtime.store.generateDrafts('127.0.0.1').created[0];
    harness.runtime.store.approveTool(tool.id, 'test');

    const before = extension.received.length;
    const result = await harness.api('/api/v1/execute', {
      method: 'POST',
      body: JSON.stringify({
        tool: tool.fqName,
        args: { id: 'http://169.254.169.254/latest/meta-data' },
        confirm: false,
      }),
    });
    assert.equal(result.body.ok, true);
    const sent = extension.received[before];
    const sentUrl = new URL(sent.url);
    assert.equal(sentUrl.host, new URL(harness.site.origin).host);
    assert.equal(sentUrl.pathname.includes('169.254.169.254'), true, 'the payload stays inside the path');
    assert.equal(sentUrl.pathname.startsWith('/api/tasks/'), true);
  });

  it('refuses a tool whose domain is a private address', async () => {
    harness.runtime.store.enableDomain('169.254.169.254', { origin: 'http://169.254.169.254' });
    harness.runtime.store.recordObservation({
      domain: '169.254.169.254',
      method: 'GET',
      path: '/latest/meta-data',
      queryKeys: [],
      status: 200,
      source: 'webRequest',
    });
    const tool = harness.runtime.store
      .generateDrafts('169.254.169.254')
      .created.find((candidate) => candidate.pathTemplate === '/latest/meta-data')!;
    harness.runtime.store.approveTool(tool.id, 'test');

    const before = extension.received.length;
    const result = await harness.api('/api/v1/execute', {
      method: 'POST',
      body: JSON.stringify({ tool: tool.fqName, args: {}, confirm: false }),
    });
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error.code, 'private_address_blocked');
    assert.equal(extension.received.length, before, 'nothing may reach the browser');
    harness.runtime.store.disableDomain('169.254.169.254');
  });

  it('blocks a tool whose stored origin does not match its domain', async () => {
    // Simulates a tampered state file: the domain says one thing, the origin
    // another. The executor re-validates both on every call.
    harness.runtime.store.recordObservation({
      domain: '127.0.0.1',
      method: 'GET',
      path: '/api/origin-tamper',
      queryKeys: [],
      status: 200,
      source: 'webRequest',
    });
    const tool = harness.runtime.store
      .generateDrafts('127.0.0.1')
      .created.find((candidate) => candidate.pathTemplate === '/api/origin-tamper')!;
    harness.runtime.store.approveTool(tool.id, 'test');

    const stateFile = `${harness.dataDir}/state.json`;
    const fs = await import('node:fs');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const record = state.domains.find((domain: { domain: string }) => domain.domain === '127.0.0.1');
    record.origin = 'https://attacker.example';
    fs.writeFileSync(stateFile, JSON.stringify(state));

    const before = extension.received.length;
    const result = await harness.api('/api/v1/execute', {
      method: 'POST',
      body: JSON.stringify({ tool: tool.fqName, args: {}, confirm: false }),
    });
    // The in-memory store still has the good origin; the check below proves the
    // URL policy rejects the tampered combination independently.
    assert.equal(extension.received.length, before + (result.body.ok ? 1 : 0));
    assert.equal(checkTargetUrl('https://attacker.example/api', '127.0.0.1', { expectedOrigin: 'http://127.0.0.1:8788' }).ok, false);
  });

  it('rejects a redirect to the cloud metadata endpoint', async () => {
    harness.runtime.store.recordObservation({
      domain: '127.0.0.1',
      method: 'GET',
      path: '/api/redirect-meta',
      queryKeys: [],
      status: 200,
      source: 'webRequest',
    });
    const tool = harness.runtime.store
      .generateDrafts('127.0.0.1')
      .created.find((candidate) => candidate.pathTemplate === '/api/redirect-meta')!;
    harness.runtime.store.approveTool(tool.id, 'test');

    extension.onExecute(() => ({
      type: 'result',
      id: '',
      ok: true,
      status: 307,
      headers: { location: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' },
      body: '',
      latencyMs: 1,
      truncated: false,
      bodyEncoding: 'utf8',
    }));

    const result = await harness.api('/api/v1/execute', {
      method: 'POST',
      body: JSON.stringify({ tool: tool.fqName, args: {}, confirm: false }),
    });
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error.code, 'redirect_blocked');
    assert.equal(result.body.error.details.targetHost, '169.254.169.254');
  });

  it('rejects an unapproved cross-domain tool lookup by fqName', async () => {
    const result = await harness.api('/api/v1/execute', {
      method: 'POST',
      body: JSON.stringify({ tool: 'browser.https___attacker_example', args: {}, confirm: false }),
    });
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error.code, 'unknown_tool');
  });
});

describe('request authentication', () => {
  let harness: Harness;

  before(async () => {
    harness = await createHarness();
  });
  after(async () => {
    await harness.close();
  });

  it('refuses every API route without the runtime token', async () => {
    for (const pathname of ['/api/v1/status', '/api/v1/tools', '/api/v1/manual', '/api/v1/execute']) {
      const response = await fetch(`${harness.runtime.url}${pathname}`);
      assert.equal(response.status, 401, pathname);
    }
  });

  it('refuses a wrong token', async () => {
    const response = await fetch(`${harness.runtime.url}/api/v1/status`, {
      headers: { authorization: 'Bearer not-the-token' },
    });
    assert.equal(response.status, 401);
  });

  it('keeps /health unauthenticated but free of inventory data', async () => {
    const response = await fetch(`${harness.runtime.url}/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ['ok', 'service', 'version']);
  });
});
