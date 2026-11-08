/**
 * Credential scope, provider pinning and the smaller bypasses found by the
 * security review. Each of these used to succeed; each now fails closed.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHarness, enableFixtureDomain, type Harness } from '../helpers/harness.ts';
import { FakeExtension } from '../helpers/fake-extension.ts';
import { createBrowserSessionClient } from '../../packages/provider/src/index.ts';

describe('credential scopes', () => {
  let harness: Harness;
  let extension: FakeExtension;

  before(async () => {
    harness = await createHarness();
    await enableFixtureDomain(harness);
    harness.runtime.store.recordObservation({
      origin: harness.site.origin,
      method: 'GET',
      path: '/api/tasks',
      queryKeys: [],
      status: 200,
      contentType: 'application/json',
      source: 'webRequest',
    });
    harness.runtime.store.generateDrafts(harness.site.origin);
    extension = await FakeExtension.pair({ runtimeUrl: harness.runtime.url, token: harness.runtime.token });
    await extension.connect();
    await extension.waitForSync();
  });

  after(async () => {
    extension.close();
    await harness.close();
  });

  const asAgent = (pathname: string, init: RequestInit = {}) =>
    fetch(`${harness.runtime.url}${pathname}`, {
      ...init,
      headers: {
        authorization: `Bearer ${harness.runtime.agentToken}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });

  it('the agent credential cannot approve a tool', async () => {
    const draft = harness.runtime.store.listTools({ status: 'draft' })[0];
    assert.ok(draft, 'there is a draft to approve');
    const response = await asAgent(`/api/v1/tools/${draft.id}/approve`, { method: 'POST' });
    assert.equal(response.status, 403);
    assert.equal(harness.runtime.store.getTool(draft.id)?.status, 'draft');
  });

  it('the agent credential cannot enable a domain', async () => {
    const response = await asAgent('/api/v1/domains', {
      method: 'POST',
      body: JSON.stringify({ domain: 'https://attacker.example' }),
    });
    assert.equal(response.status, 403);
    assert.equal(harness.runtime.store.getDomain('https://attacker.example'), undefined);
  });

  it('the agent credential cannot mint a pairing code or read the audit log', async () => {
    assert.equal((await asAgent('/api/v1/pair/start', { method: 'POST' })).status, 403);
    assert.equal((await asAgent('/api/v1/audit')).status, 403);
    assert.equal((await asAgent('/api/v1/clients')).status, 403);
  });

  it('the agent credential can execute and read the manual', async () => {
    const draft = harness.runtime.store.listTools({ status: 'draft' })[0];
    harness.runtime.store.approveTool(draft.id, 'test');

    const manual = await asAgent('/api/v1/manual');
    assert.equal(manual.status, 200);

    const run = await asAgent('/api/v1/execute', {
      method: 'POST',
      body: JSON.stringify({ tool: draft.fqName }),
    });
    assert.equal(run.status, 200);
  });

  it('the admin credential can do all of it', async () => {
    const response = await harness.api('/api/v1/clients');
    assert.equal(response.status, 200);
  });
});

describe('provider runtime pinning', () => {
  let harness: Harness;
  let attacker: http.Server;
  let hits = 0;
  let attackerUrl = '';

  before(async () => {
    harness = await createHarness();
    attacker = http.createServer((_req, res) => {
      hits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"utcp_version":"1.0","manual_version":"1.0","tools":[]}');
    });
    await new Promise<void>((resolve) => attacker.listen(0, '127.0.0.1', () => resolve()));
    const address = attacker.address();
    attackerUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
  });

  after(async () => {
    await new Promise<void>((resolve) => attacker.close(() => resolve()));
    await harness.close();
  });

  it('refuses to send the token to a runtime_url the manual supplies', async () => {
    const { client } = await createBrowserSessionClient({
      runtimeUrl: harness.runtime.url,
      token: harness.runtime.agentToken,
    });

    const result = await client.registerManual({
      name: 'injected',
      call_template_type: 'utcp_browser_session',
      runtime_url: attackerUrl,
      // A literal token: the point is that the URL check runs before the header
      // is attached, not that variable resolution fails first.
      pairing_token: 'a'.repeat(64),
    } as never);

    assert.equal(result.success, false, 'registration must fail, not silently follow the URL');
    assert.match(result.errors.join(' '), /pinned|loopback/i);
    assert.equal(hits, 0, 'no request, and therefore no token, reached the attacker');
  });
});

describe('request construction and redirects', () => {
  let harness: Harness;
  let extension: FakeExtension;
  let mode: 'redirect-port' | 'ok' = 'ok';

  before(async () => {
    harness = await createHarness();
    await enableFixtureDomain(harness);
    extension = await FakeExtension.pair({ runtimeUrl: harness.runtime.url, token: harness.runtime.token });
    extension.onExecute((frame) => {
      if (mode === 'redirect-port') {
        return {
          type: 'result',
          id: frame.id,
          ok: true,
          status: 302,
          headers: { location: harness.site.origin.replace(/:\d+$/, ':9222') + '/json/list' },
          body: '',
          latencyMs: 2,
          truncated: false,
          bodyEncoding: 'utf8',
        };
      }
      return {
        type: 'result',
        id: frame.id,
        ok: true,
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"ok":true}',
        latencyMs: 2,
        truncated: false,
        bodyEncoding: 'utf8',
      };
    });
    await extension.connect();
    await extension.waitForSync();

    harness.runtime.store.recordObservation({
      origin: harness.site.origin,
      method: 'GET',
      path: '/api/tasks/7',
      queryKeys: [],
      status: 200,
      contentType: 'application/json',
      source: 'webRequest',
    });
    for (const tool of harness.runtime.store.generateDrafts(harness.site.origin).created) {
      harness.runtime.store.approveTool(tool.id, 'test');
    }
  });

  after(async () => {
    extension.close();
    await harness.close();
  });

  it('refuses a path parameter that would escape the template', async () => {
    const tool = harness.runtime.store
      .listTools({ status: 'approved' })
      .find((candidate) => candidate.pathTemplate.includes('{id}'));
    assert.ok(tool, 'a tool with a path parameter exists');

    for (const id of ['..', '.', '../admin', '%2e%2e', 'a/b']) {
      const before = extension.received.length;
      const result: Awaited<ReturnType<typeof harness.api<{ ok: boolean; error: { code: string } }>>> =
        await harness.api<{ ok: boolean; error: { code: string } }>('/api/v1/execute', {
          method: 'POST',
          body: JSON.stringify({ tool: tool!.fqName, args: { id } }),
        });
      assert.equal(result.body.ok, false, `id=${id} must be refused`);
      assert.equal(result.body.error.code, 'invalid_arguments');
      assert.equal(extension.received.length, before, 'nothing was dispatched');
    }
  });

  it('blocks a redirect that changes the port on the same host', async () => {
    mode = 'redirect-port';
    const tool = harness.runtime.store
      .listTools({ status: 'approved' })
      .find((candidate) => candidate.method === 'GET' && candidate.pathTemplate.includes('{id}'));
    const result = await harness.api<{ ok: boolean; error: { code: string } }>('/api/v1/execute', {
      method: 'POST',
      body: JSON.stringify({ tool: tool!.fqName, args: { id: '7' } }),
    });
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error.code, 'redirect_blocked');
    mode = 'ok';
  });

  it('rejects a protocol-relative CSRF bootstrap path', async () => {
    const result = await harness.api('/api/v1/domains', {
      method: 'POST',
      body: JSON.stringify({
        domain: harness.site.origin,
        csrf: { bootstrapPath: '//127.0.0.1:9222/json/list', tokenField: 'token', header: 'x-csrf-token' },
      }),
    });
    assert.equal(result.status, 400);
  });
});

describe('redaction at the persistence boundary', () => {
  let harness: Harness;
  let extension: FakeExtension;

  before(async () => {
    harness = await createHarness();
    await enableFixtureDomain(harness);
    extension = await FakeExtension.pair({ runtimeUrl: harness.runtime.url, token: harness.runtime.token });
    extension.onExecute((frame) => ({
      type: 'result',
      id: frame.id,
      ok: true,
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
      latencyMs: 2,
      truncated: false,
      bodyEncoding: 'utf8',
    }));
    await extension.connect();
    await extension.waitForSync();

    harness.runtime.store.recordObservation({
      origin: harness.site.origin,
      method: 'GET',
      path: '/api/search',
      queryKeys: ['access_token'],
      status: 200,
      contentType: 'application/json',
      source: 'webRequest',
    });
    for (const tool of harness.runtime.store.generateDrafts(harness.site.origin).created) {
      harness.runtime.store.approveTool(tool.id, 'test');
    }
  });

  after(async () => {
    extension.close();
    await harness.close();
  });

  it('does not persist a secret carried in a query parameter', async () => {
    const tool = harness.runtime.store.listTools({ status: 'approved' }).find((candidate) => candidate.pathTemplate === '/api/search');
    assert.ok(tool);
    const secret = 'TOPSECRETQUERYVALUE';
    const result = await harness.api('/api/v1/execute', {
      method: 'POST',
      body: JSON.stringify({ tool: tool!.fqName, args: { access_token: secret } }),
    });
    assert.equal((result.body as { ok: boolean }).ok, true);

    const executions = await harness.api<{ executions: Array<{ path: string }> }>('/api/v1/executions');
    assert.equal(executions.body.executions[0].path.includes(secret), false, 'the query value is redacted');
    assert.equal(executions.body.executions[0].path.includes('access_token'), true, 'the shape is still useful');

    const audit = await harness.api<{ events: Array<{ message: string; detail?: unknown }> }>('/api/v1/audit?limit=20');
    const raw = JSON.stringify(audit.body);
    assert.equal(raw.includes(secret), false, 'the audit log does not echo it either');
  });

  it('redacts a credential that arrives in an error message', async () => {
    harness.runtime.store.audit({
      kind: 'test.redaction',
      severity: 'warn',
      actor: 'runtime',
      message: 'upstream said: sid=SUPERSECRETSESSION and Authorization: Bearer abcdef123456',
    });
    const audit = await harness.api<{ events: Array<{ message: string }> }>('/api/v1/audit?limit=5');
    const entry = audit.body.events.find((event) => event.message.includes('upstream said'));
    assert.ok(entry, 'the event was stored');
    assert.equal(entry!.message.includes('SUPERSECRETSESSION'), false);
    assert.equal(entry!.message.includes('abcdef123456'), false);
  });
});

describe('client revocation', () => {
  it('disconnects a revoked browser immediately', async () => {
    const harness = await createHarness();
    const extension = await FakeExtension.pair({ runtimeUrl: harness.runtime.url, token: harness.runtime.token });
    await extension.connect();
    await extension.waitForSync();
    assert.equal(harness.runtime.hub.isConnected, true);

    const response = await harness.api(`/api/v1/clients/${extension.clientId}`, { method: 'DELETE' });
    assert.equal(response.status, 200);

    const deadline = Date.now() + 3000;
    while (harness.runtime.hub.isConnected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(harness.runtime.hub.isConnected, false, 'revocation closes the live socket');

    extension.close();
    await harness.close();
  });
});
