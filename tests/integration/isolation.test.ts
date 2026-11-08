/**
 * Isolation between websites, without a browser.
 *
 * Two applications on the same host and different ports is the case that a
 * hostname-keyed model gets wrong: the second `enable` used to overwrite the
 * first origin, so tools discovered on app A would execute against app B.
 * Here the store, the tool inventory and the dispatch target are all checked
 * per origin.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, enableFixtureDomain, type Harness } from '../helpers/harness.ts';
import { FakeExtension } from '../helpers/fake-extension.ts';

const SITE_A = 'http://127.0.0.1:8788';
const SITE_B = 'http://127.0.0.1:8789';

describe('same host, different origin', () => {
  let harness: Harness;
  let extension: FakeExtension;

  before(async () => {
    harness = await createHarness();
    await enableFixtureDomain(harness);
    harness.runtime.store.enableDomain(SITE_A, '127.0.0.1');
    harness.runtime.store.enableDomain(SITE_B, '127.0.0.1');
    extension = await FakeExtension.pair({ runtimeUrl: harness.runtime.url, token: harness.runtime.token });
    extension.onExecute((frame) => ({
      type: 'result',
      id: frame.id,
      ok: true,
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ origin: frame.origin, url: frame.url }),
      latencyMs: 2,
      truncated: false,
      bodyEncoding: 'utf8',
    }));
    await extension.connect();
    await extension.waitForSync();
  });

  after(async () => {
    extension.close();
    await harness.close();
  });

  it('keeps one domain record per origin', () => {
    const origins = harness.runtime.store.listDomains().map((domain) => domain.origin);
    assert.ok(origins.includes(SITE_A), 'A is enabled');
    assert.ok(origins.includes(SITE_B), 'B is enabled');
    assert.equal(harness.runtime.store.getDomain(SITE_A)?.origin, SITE_A);
    assert.equal(harness.runtime.store.getDomain(SITE_B)?.origin, SITE_B);
  });

  it('creates a separate endpoint record per origin', () => {
    for (const origin of [SITE_A, SITE_B]) {
      harness.runtime.store.recordObservation({
        origin,
        method: 'GET',
        path: '/api/tasks',
        queryKeys: ['status'],
        status: 200,
        contentType: 'application/json',
        source: 'webRequest',
        responseShape: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { id: { type: 'number' } } } } } },
      });
    }
    const endpoints = harness.runtime.store.listEndpoints();
    const keys = endpoints.map((endpoint) => endpoint.key);
    assert.ok(keys.includes(`${SITE_A} GET /api/tasks`));
    assert.ok(keys.includes(`${SITE_B} GET /api/tasks`));
    assert.equal(endpoints.length, 2, 'the same path on two origins is two records');
  });

  it('binds tools to the origin they were discovered on', () => {
    const a = harness.runtime.store.generateDrafts(SITE_A).created;
    const b = harness.runtime.store.generateDrafts(SITE_B).created;
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.equal(a[0].origin, SITE_A);
    assert.equal(b[0].origin, SITE_B);
    assert.notEqual(a[0].id, b[0].id);
    // Names are unique inside the manual even when paths collide.
    assert.notEqual(a[0].name, b[0].name);
  });

  it('dispatches each tool to its own origin', async () => {
    const tools = harness.runtime.store.listTools().filter((tool) => tool.status === 'draft');
    for (const tool of tools) harness.runtime.store.approveTool(tool.id, 'test');

    for (const tool of harness.runtime.store.listTools({ status: 'approved' })) {
      const result = await harness.api<{ ok: boolean; body: { origin: string; url: string } }>('/api/v1/execute', {
        method: 'POST',
        body: JSON.stringify({ tool: tool.fqName }),
      });
      assert.equal(result.body.ok, true);
      assert.equal(result.body.body.origin, tool.origin);
      assert.ok(result.body.body.url.startsWith(tool.origin), `${tool.fqName} called ${result.body.body.url}`);
    }
  });

  it('records session state per origin', () => {
    harness.runtime.store.setSession(SITE_A, 'expired', 401, 'website_auth_expired');
    assert.equal(harness.runtime.store.getDomain(SITE_A)?.session.status, 'expired');
    assert.notEqual(harness.runtime.store.getDomain(SITE_B)?.session.status, 'expired', 'B keeps its own session');
    harness.runtime.store.setSession(SITE_B, 'ok', 200, null);
    assert.equal(harness.runtime.store.getDomain(SITE_B)?.session.status, 'ok');
  });

  it('disabling one origin revokes only its own tools', async () => {
    assert.equal(harness.runtime.store.disableDomain(SITE_A), true);
    const tools = harness.runtime.store.listTools();
    assert.ok(tools.filter((tool) => tool.origin === SITE_A).every((tool) => tool.status === 'revoked'));
    assert.ok(tools.filter((tool) => tool.origin === SITE_B).every((tool) => tool.status === 'approved'));
    assert.equal(harness.runtime.store.isDomainEnabled(SITE_A), false);
    assert.equal(harness.runtime.store.isDomainEnabled(SITE_B), true);
  });

  it('refuses the disabled origin before any browser dispatch', async () => {
    const tool = harness.runtime.store.listTools().find((candidate) => candidate.origin === SITE_A);
    const before = extension.received.length;
    const result = await harness.api<{ ok: boolean; error: { code: string } }>('/api/v1/execute', {
      method: 'POST',
      body: JSON.stringify({ tool: tool!.fqName }),
    });
    assert.equal(result.body.ok, false);
    assert.ok(['tool_revoked', 'domain_not_allowed'].includes(result.body.error.code));
    assert.equal(extension.received.length, before, 'nothing reached the browser');
  });
});

describe('domain policy ceiling', () => {
  let harness: Harness;
  let extension: FakeExtension;

  before(async () => {
    harness = await createHarness();
    await enableFixtureDomain(harness);
    extension = await FakeExtension.pair({ runtimeUrl: harness.runtime.url, token: harness.runtime.token });
    await extension.connect();
    await extension.waitForSync();
  });

  after(async () => {
    extension.close();
    await harness.close();
  });

  it('caps a tool at the domain ceiling and blocks it at execution time', async () => {
    harness.runtime.store.recordObservation({
      origin: harness.site.origin,
      method: 'POST',
      path: '/api/tasks',
      queryKeys: [],
      status: 201,
      contentType: 'application/json',
      source: 'webRequest',
      requestShape: { type: 'object', properties: { title: { type: 'string' } } },
    });
    const draft = harness.runtime.store.generateDrafts(harness.site.origin).created[0];
    assert.equal(draft.permission, 'WRITE');

    // Approval under a permissive ceiling, then a tightening of the policy.
    harness.runtime.store.approveTool(draft.id, 'test');
    harness.runtime.store.updatePolicy(harness.site.origin, { maxPermission: 'READ' });

    const tool = harness.runtime.store.getTool(draft.id)!;
    assert.equal(tool.permission, 'WRITE', 'the label is not silently downgraded');

    const before = extension.received.length;
    const result = await harness.api<{ ok: boolean; error: { code: string } }>('/api/v1/execute', {
      method: 'POST',
      body: JSON.stringify({ tool: tool.fqName, args: { title: 'x' } }),
    });
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error.code, 'policy_blocked');
    assert.equal(extension.received.length, before, 'nothing reached the browser');
  });

  it('refuses drafts for blocked path prefixes', () => {
    harness.runtime.store.updatePolicy(harness.site.origin, { maxPermission: 'DESTRUCTIVE', blockedPathPrefixes: ['/admin'] });
    harness.runtime.store.recordObservation({
      origin: harness.site.origin,
      method: 'GET',
      path: '/admin/users',
      queryKeys: [],
      status: 200,
      contentType: 'application/json',
      source: 'webRequest',
    });
    const endpoint = harness.runtime.store
      .listEndpoints(harness.site.origin)
      .find((candidate) => candidate.pathTemplate === '/admin/users');
    assert.ok(endpoint?.blocked, 'the endpoint is marked blocked');

    const generated = harness.runtime.store.generateDrafts(harness.site.origin);
    assert.equal(generated.created.some((tool) => tool.pathTemplate === '/admin/users'), false);
    assert.ok(generated.skipped.some((entry) => entry.includes('/admin/users')));
  });
});
