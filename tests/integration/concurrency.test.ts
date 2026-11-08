/**
 * Concurrency control: bounded in-flight calls, a bounded queue, and
 * cancellation when the caller hangs up.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, enableFixtureDomain, type Harness } from '../helpers/harness.ts';
import { FakeExtension } from '../helpers/fake-extension.ts';

describe('bounded concurrency', () => {
  let harness: Harness;
  let extension: FakeExtension;
  let concurrent = 0;
  let peak = 0;

  before(async () => {
    harness = await createHarness();
    await enableFixtureDomain(harness);
    harness.runtime.store.updateSettings({ maxInFlight: 2, maxQueue: 2, rateLimitPerMinute: 600 });

    harness.runtime.store.recordObservation({
      origin: harness.site.origin,
      method: 'GET',
      path: '/api/tasks',
      queryKeys: [],
      status: 200,
      contentType: 'application/json',
      source: 'webRequest',
    });
    for (const tool of harness.runtime.store.generateDrafts(harness.site.origin).created) {
      harness.runtime.store.approveTool(tool.id, 'test');
    }

    extension = await FakeExtension.pair({ runtimeUrl: harness.runtime.url, token: harness.runtime.token });
    extension.onExecute(async (frame) => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 120));
      concurrent -= 1;
      return {
        type: 'result',
        id: frame.id,
        ok: true,
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"ok":true}',
        latencyMs: 120,
        truncated: false,
        bodyEncoding: 'utf8',
      };
    });
    await extension.connect();
    await extension.waitForSync();
  });

  after(async () => {
    extension.close();
    await harness.close();
  });

  it('never exceeds maxInFlight, queues the rest, and rejects beyond the queue', async () => {
    const tool = harness.runtime.store.listTools({ status: 'approved' })[0];
    const calls = Array.from({ length: 5 }, () =>
      harness.api<{ ok: boolean; error?: { code: string } }>('/api/v1/execute', {
        method: 'POST',
        body: JSON.stringify({ tool: tool.fqName }),
      }),
    );
    const results = await Promise.all(calls);

    const succeeded = results.filter((result) => result.body.ok).length;
    const busy = results.filter((result) => result.body.error?.code === 'busy').length;

    assert.equal(busy, 1, 'the fifth call is rejected, not buffered');
    assert.equal(succeeded, 4, 'two ran and two were queued');
    assert.equal(peak <= 2, true, `peak concurrency was ${peak}`);

    const metrics = harness.runtime.hub.metrics();
    assert.equal(metrics.counters.callsQueued >= 2, true);
    assert.equal(metrics.counters.callsRejectedBusy, 1);
    assert.equal(metrics.queued, 0, 'the queue drained');
    assert.equal(metrics.inFlight, 0);
  });

  it('cancels the browser request when the caller disconnects', async () => {
    const tool = harness.runtime.store.listTools({ status: 'approved' })[0];
    const controller = new AbortController();
    const request = fetch(`${harness.runtime.url}/api/v1/execute`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${harness.runtime.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ tool: tool.fqName }),
      signal: controller.signal,
    }).catch(() => undefined);

    await new Promise((resolve) => setTimeout(resolve, 60));
    controller.abort();
    await request;

    // The runtime records the cancellation and stops waiting for a result.
    const deadline = Date.now() + 2000;
    while (harness.runtime.hub.metrics().counters.cancellations === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(harness.runtime.hub.metrics().counters.cancellations >= 1, true);

    // The hub is still usable afterwards.
    const after = await harness.api<{ ok: boolean }>('/api/v1/execute', {
      method: 'POST',
      body: JSON.stringify({ tool: tool.fqName }),
    });
    assert.equal(after.body.ok, true);
  });
});
