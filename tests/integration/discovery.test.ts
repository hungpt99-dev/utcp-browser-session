import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, enableFixtureDomain, type Harness } from '../helpers/harness.ts';
import { FakeExtension } from '../helpers/fake-extension.ts';

async function waitFor<T>(check: () => Promise<T | null>, timeoutMs = 4000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value !== null) return value;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

describe('discovery', () => {
  let harness: Harness;
  let extension: FakeExtension;

  before(async () => {
    harness = await createHarness();
    await enableFixtureDomain(harness);
    extension = await FakeExtension.pair({ runtimeUrl: harness.runtime.url, token: harness.runtime.token });
    await extension.connect();
    await extension.waitForSync();
    await harness.api(`/api/v1/domains/${encodeURIComponent('127.0.0.1')}/discovery`, { method: 'POST' });
  });

  after(async () => {
    extension.close();
    await harness.close();
  });

  it('records endpoints only while capture is active', async () => {
    extension.sendDiscovery([
      {
        domain: '127.0.0.1',
        method: 'GET',
        path: '/api/tasks',
        queryKeys: ['status', 'limit'],
        status: 200,
        contentType: 'application/json',
        source: 'webRequest',
      },
    ]);

    const endpoints = await waitFor(async () => {
      const result = await harness.api('/api/v1/endpoints');
      return result.body.endpoints.length > 0 ? result.body.endpoints : null;
    });
    const endpoint = endpoints[0];
    assert.equal(endpoint.key, 'GET /api/tasks');
    assert.deepEqual(endpoint.queryKeys.sort(), ['limit', 'status']);
    assert.equal(endpoint.sources[0], 'webRequest');
  });

  it('merges repeated observations and unions the inferred schema', async () => {
    extension.sendDiscovery([
      {
        domain: '127.0.0.1',
        method: 'POST',
        path: '/api/tasks',
        queryKeys: [],
        status: 201,
        contentType: 'application/json',
        source: 'page-tap',
        requestShape: { type: 'object', properties: { title: { type: 'string' } } },
        responseShape: { type: 'object', properties: { id: { type: 'number' } } },
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    extension.sendDiscovery([
      {
        domain: '127.0.0.1',
        method: 'POST',
        path: '/api/tasks',
        queryKeys: [],
        status: 201,
        contentType: 'application/json',
        source: 'page-tap',
        requestShape: { type: 'object', properties: { title: { type: 'string' }, priority: { type: 'number' } } },
        responseShape: { type: 'object', properties: { id: { type: 'number' }, created: { type: 'boolean' } } },
      },
    ]);

    const endpoint = await waitFor(async () => {
      const result = await harness.api('/api/v1/endpoints?domain=127.0.0.1');
      const found = result.body.endpoints.find((candidate: { key: string }) => candidate.key === 'POST /api/tasks');
      return found && found.sampleCount >= 2 ? found : null;
    });
    assert.equal(endpoint.permission, 'WRITE');
    assert.deepEqual(Object.keys(endpoint.requestSchema.properties).sort(), ['priority', 'title']);
    assert.deepEqual(Object.keys(endpoint.responseSchema.properties).sort(), ['created', 'id']);
  });

  it('ignores observations for domains that are not enabled', async () => {
    extension.sendDiscovery([
      { domain: 'example.org', method: 'GET', path: '/api/secret', queryKeys: [], status: 200, source: 'webRequest' },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const result = await harness.api('/api/v1/endpoints');
    assert.equal(result.body.endpoints.some((endpoint: { domain: string }) => endpoint.domain === 'example.org'), false);
    assert.ok(harness.runtime.hub.status().counters.observationsDropped >= 1);
  });

  it('creates draft tools that are not executable or listed in the manual', async () => {
    const generated = await harness.api('/api/v1/tools/generate', {
      method: 'POST',
      body: JSON.stringify({ domain: '127.0.0.1' }),
    });
    assert.equal(generated.status, 201);
    const created = generated.body.created as Array<{ fqName: string; status: string }>;
    assert.ok(created.length >= 2);
    assert.ok(created.every((tool) => tool.status === 'draft'));

    const manual = await harness.api('/api/v1/manual');
    assert.equal(manual.body.tools.length, 0);

    const names = created.map((tool) => tool.fqName).sort();
    assert.ok(names.includes('browser.list_tasks'), names.join(', '));
    assert.ok(names.includes('browser.create_task'));
  });

  it('stops recording when discovery is stopped', async () => {
    await harness.api(`/api/v1/domains/${encodeURIComponent('127.0.0.1')}/discovery`, { method: 'DELETE' });
    const before = (await harness.api('/api/v1/endpoints')).body.endpoints.length;
    extension.sendDiscovery([
      { domain: '127.0.0.1', method: 'GET', path: '/api/after-stop', queryKeys: [], status: 200, source: 'webRequest' },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const after = (await harness.api('/api/v1/endpoints')).body.endpoints.length;
    assert.equal(after, before);
  });

  it('reports discovery counters so the dashboard can prove data flowed', () => {
    const counters = harness.runtime.hub.status().counters;
    assert.ok(counters.discoveryFrames >= 3);
    assert.ok(counters.observationsIngested >= 3);
  });
});
