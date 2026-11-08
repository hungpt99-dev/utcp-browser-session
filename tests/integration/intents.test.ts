/**
 * Popup intents.
 *
 * The extension popup has no runtime token, so its buttons travel over the
 * already-authenticated websocket as `intent` frames. These frames used to be
 * dropped silently by the runtime — the button appeared to work and nothing
 * happened. This suite pins the behaviour down.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, type Harness } from '../helpers/harness.ts';
import { FakeExtension } from '../helpers/fake-extension.ts';

describe('extension intents', () => {
  let harness: Harness;
  let extension: FakeExtension;

  before(async () => {
    harness = await createHarness();
    extension = await FakeExtension.pair({ runtimeUrl: harness.runtime.url, token: harness.runtime.token });
    await extension.connect();
    await extension.waitForSync();
  });

  after(async () => {
    extension.close();
    await harness.close();
  });

  it('enables an origin the human approved from the popup', async () => {
    const origin = harness.site.origin;
    extension.send({ type: 'intent', action: 'enable_origin', origin, deepCapture: true });

    const deadline = Date.now() + 3000;
    while (!harness.runtime.store.isDomainEnabled(origin) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    const record = harness.runtime.store.getDomain(origin);
    assert.equal(record?.enabled, true, 'the origin is enabled');
    assert.equal(record?.domain, '127.0.0.1');
    assert.equal(record?.deepCapture, true);

    // The allowlist was pushed back to the extension.
    const synced = extension.lastSyncFrame();
    assert.ok(synced?.enabledOrigins.includes(origin));

    // And the action is auditable.
    const audit = await harness.api<{ events: Array<{ kind: string; origin: string | null }> }>('/api/v1/audit?limit=20');
    assert.ok(audit.body.events.some((event) => event.kind === 'domain.enabled' && event.origin === origin));
  });

  it('starts and stops discovery for an enabled origin', async () => {
    const origin = harness.site.origin;
    extension.send({ type: 'intent', action: 'discovery_start', origin });

    const deadline = Date.now() + 3000;
    while (!harness.runtime.hub.status().capturing.includes(origin) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.ok(harness.runtime.hub.status().capturing.includes(origin), 'the runtime records capture');

    extension.send({ type: 'intent', action: 'discovery_stop', origin });
    const stopped = Date.now() + 3000;
    while (harness.runtime.hub.status().capturing.includes(origin) && Date.now() < stopped) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(harness.runtime.hub.status().capturing.includes(origin), false);
  });

  it('refuses discovery for an origin that was never enabled', async () => {
    const origin = 'https://not-enabled.example';
    extension.send({ type: 'intent', action: 'discovery_start', origin });
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(harness.runtime.hub.status().capturing.includes(origin), false);
    assert.equal(harness.runtime.store.isDomainEnabled(origin), false);
  });

  it('ignores intents with a non-http origin', async () => {
    extension.send({ type: 'intent', action: 'enable_origin', origin: 'file:///etc/passwd' });
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(harness.runtime.store.listDomains().some((domain) => domain.origin.startsWith('file:')), false);
  });

  it('disabling from the popup revokes that origin only', async () => {
    const origin = harness.site.origin;
    extension.send({ type: 'intent', action: 'disable_origin', origin });
    const deadline = Date.now() + 3000;
    while (harness.runtime.store.isDomainEnabled(origin) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(harness.runtime.store.isDomainEnabled(origin), false);
  });
});
