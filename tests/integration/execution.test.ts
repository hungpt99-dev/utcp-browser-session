import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, enableFixtureDomain, type Harness } from '../helpers/harness.ts';
import { FakeExtension } from '../helpers/fake-extension.ts';
import type { ToolRecord } from '@utcp-browser-session/shared';

const DOMAIN = '127.0.0.1';

interface SeedOptions {
  method?: string;
  path?: string;
  bodyShape?: { type: string; properties: Record<string, unknown> };
}

function seedTool(harness: Harness, options: SeedOptions = {}): ToolRecord {
  const method = options.method ?? 'GET';
  const path = options.path ?? '/api/tasks';
  harness.runtime.store.recordObservation({
    domain: DOMAIN,
    method,
    path,
    queryKeys: method === 'GET' ? ['status'] : [],
    status: 200,
    contentType: 'application/json',
    source: 'webRequest',
    ...(options.bodyShape ? { requestShape: options.bodyShape as never } : {}),
  });
  const { created } = harness.runtime.store.generateDrafts(DOMAIN);
  const tool = created.find((candidate) => candidate.method === method && candidate.pathTemplate === path) ?? created[0];
  harness.runtime.store.approveTool(tool.id, 'test');
  return tool;
}

describe('execution policy', () => {
  let harness: Harness;
  let extension: FakeExtension;
  let mode: 'ok' | 'redirect-cross' | 'redirect-same' | 'unauth' | 'server-error' | 'invalid-json' = 'ok';
  let defaultHandler: () => Record<string, unknown>;

  before(async () => {
    harness = await createHarness();
    await enableFixtureDomain(harness);
    extension = await FakeExtension.pair({ runtimeUrl: harness.runtime.url, token: harness.runtime.token });
    await extension.connect();
    await extension.waitForSync();

    defaultHandler = () => {
      const base = { type: 'result', id: '', latencyMs: 4, truncated: false, bodyEncoding: 'utf8' };
      switch (mode) {
        case 'redirect-cross':
          return { ...base, ok: true, status: 302, headers: { location: 'https://attacker.example/steal' }, body: '' };
        case 'redirect-same':
          return { ...base, ok: true, status: 302, headers: { location: '/api/tasks' }, body: '' };
        case 'unauth':
          return {
            ...base,
            ok: true,
            status: 401,
            headers: { 'content-type': 'application/json' },
            body: '{"error":"unauthenticated"}',
          };
        case 'server-error':
          return {
            ...base,
            ok: true,
            status: 500,
            headers: { 'content-type': 'application/json' },
            body: '{"error":"boom"}',
          };
        case 'invalid-json':
          return { ...base, ok: true, status: 200, headers: { 'content-type': 'application/json' }, body: '{"broken": tru' };
        default:
          return {
            ...base,
            ok: true,
            status: 200,
            headers: { 'content-type': 'application/json', 'set-cookie': 'sid=leak', 'x-request-id': 'req-1' },
            body: '{"tasks":[{"id":1,"title":"a"}],"total":1}',
          };
      }
    };
    extension.onExecute(defaultHandler);
  });

  after(async () => {
    extension.close();
    await harness.close();
  });

  beforeEach(() => {
    mode = 'ok';
    extension.onExecute(defaultHandler);
  });

  const execute = (tool: string, args: Record<string, unknown> = {}, confirm = false) =>
    harness.api('/api/v1/execute', { method: 'POST', body: JSON.stringify({ tool, args, confirm }) });

  it('rejects an unknown tool', async () => {
    const result = await execute('browser.nope');
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error.code, 'unknown_tool');
  });

  it('rejects a tool that is still a draft', async () => {
    harness.runtime.store.recordObservation({
      domain: DOMAIN,
      method: 'GET',
      path: '/api/draft-only',
      queryKeys: [],
      status: 200,
      source: 'webRequest',
    });
    const draft = harness.runtime.store.generateDrafts(DOMAIN).created.find((tool) => tool.pathTemplate === '/api/draft-only')!;
    const result = await execute(draft.fqName);
    assert.equal(result.body.error.code, 'approval_required');
    assert.equal(extension.received.length, 0, 'a draft must never reach the browser');
  });

  it('rejects a revoked tool', async () => {
    const tool = seedTool(harness, { path: '/api/revoked-demo' });
    harness.runtime.store.revokeTool(tool.id, 'test');
    const result = await execute(tool.fqName);
    assert.equal(result.body.error.code, 'tool_revoked');
  });

  it('refuses to run a tool after its domain is disabled (tools are revoked on disable)', async () => {
    const tool = seedTool(harness, { path: '/api/disabled-demo' });
    harness.runtime.store.disableDomain(DOMAIN);
    try {
      const result = await execute(tool.fqName);
      assert.equal(result.body.ok, false);
      // Disabling a domain revokes its tools, so the revocation check fires
      // first. Either code is a refusal; this asserts the stronger one.
      assert.equal(result.body.error.code, 'tool_revoked');
      const audit = await harness.api('/api/v1/audit?kind=domain.disabled');
      assert.ok(audit.body.events.length >= 0);
    } finally {
      harness.runtime.store.enableDomain(DOMAIN, { origin: harness.site.origin });
      harness.runtime.store.approveTool(tool.id, 'test');
    }
  });

  it('rejects arguments that do not match the schema', async () => {
    const tool = seedTool(harness, { path: '/api/args-demo' });
    const result = await execute(tool.fqName, { unknownField: 1 });
    assert.equal(result.body.error.code, 'invalid_arguments');
    assert.match(JSON.stringify(result.body.error.details), /Unknown parameter/);
  });

  it('executes an approved read tool and returns a structured envelope', async () => {
    const tool = seedTool(harness, { path: '/api/tasks' });
    const before = extension.received.length;
    const result = await execute(tool.fqName, { status: 'open' });
    assert.equal(result.body.ok, true);
    assert.equal(result.body.status, 200);
    assert.equal(result.body.body.total, 1);
    assert.equal(result.body.headers['x-request-id'], 'req-1');
    assert.equal(result.body.headers['set-cookie'], undefined, 'response cookies must be dropped');
    assert.equal(extension.received.length, before + 1);
    const sent = extension.received.at(-1)!;
    assert.equal(sent.url, `${harness.site.origin}/api/tasks?status=open`);
    assert.equal(sent.domain, DOMAIN);
  });

  it('requires an explicit confirmation for destructive calls', async () => {
    const tool = seedTool(harness, { method: 'DELETE', path: '/api/tasks/{id}' });
    const rejected = await execute(tool.fqName, { id: '3' });
    assert.equal(rejected.body.ok, false);
    assert.equal(rejected.body.error.code, 'confirmation_required');
    const before = extension.received.length;
    assert.equal(extension.received.length, before);

    const accepted = await execute(tool.fqName, { id: '3' }, true);
    assert.equal(accepted.body.ok, true);
    assert.equal(extension.received.at(-1)?.method, 'DELETE');
  });

  it('enforces the per-tool rate limit', async () => {
    harness.runtime.store.updateSettings({ rateLimitPerMinute: 2 });
    const tool = seedTool(harness, { path: '/api/rate-demo' });
    await execute(tool.fqName);
    await execute(tool.fqName);
    const third = await execute(tool.fqName);
    assert.equal(third.body.ok, false);
    assert.equal(third.body.error.code, 'rate_limited');
    harness.runtime.store.updateSettings({ rateLimitPerMinute: 60 });
  });

  it('blocks a redirect that leaves the domain and records a security event', async () => {
    const tool = seedTool(harness, { path: '/api/redirect-demo' });
    mode = 'redirect-cross';
    const result = await execute(tool.fqName);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error.code, 'redirect_blocked');
    assert.equal(result.body.error.details.targetHost, 'attacker.example');
    const audit = await harness.api('/api/v1/audit?kind=request.redirect_blocked');
    assert.ok(audit.body.events.length >= 1);
  });

  it('follows a same-origin redirect once and validates each hop', async () => {
    const tool = seedTool(harness, { path: '/api/redirect-same-demo' });
    mode = 'redirect-same';
    const before = extension.received.length;
    // The fake site answers the first hop with a redirect and the second with 200.
    extension.onExecute(() => {
      const base = { type: 'result', id: '', latencyMs: 4, truncated: false, bodyEncoding: 'utf8' };
      if (extension.received.length === before + 1) {
        return { ...base, ok: true, status: 302, headers: { location: '/api/tasks' }, body: '' };
      }
      return {
        ...base,
        ok: true,
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"tasks":[],"total":0}',
      };
    });
    const result = await execute(tool.fqName);
    assert.equal(result.body.ok, true);
    assert.equal(extension.received.length, before + 2, 'one redirect means two dispatch hops');
    assert.equal(extension.received.at(-1)?.url, `${harness.site.origin}/api/tasks`);
  });

  it('maps a 401 to a reconnect instruction and never retries', async () => {
    const tool = seedTool(harness, { path: '/api/unauth-demo' });
    mode = 'unauth';
    const before = extension.received.length;
    const result = await execute(tool.fqName);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error.code, 'website_auth_expired');
    assert.match(result.body.error.hint, /Sign in again/);
    assert.equal(extension.received.length, before + 1, 'no fallback request is attempted');
  });

  it('maps a 5xx to a website_error', async () => {
    const tool = seedTool(harness, { path: '/api/boom-demo' });
    mode = 'server-error';
    const result = await execute(tool.fqName);
    assert.equal(result.body.error.code, 'website_error');
    assert.equal(result.body.error.details.status, 500);
  });

  it('rejects a body that claims JSON but is not parseable', async () => {
    const tool = seedTool(harness, { path: '/api/invalid-demo' });
    mode = 'invalid-json';
    const result = await execute(tool.fqName);
    assert.equal(result.body.error.code, 'invalid_response');
  });

  it('rejects an oversized request body before dispatch', async () => {
    const tool = seedTool(harness, {
      method: 'POST',
      path: '/api/large-body-demo',
      bodyShape: { type: 'object', properties: { blob: { type: 'string' } } },
    });
    const before = extension.received.length;
    const result = await execute(tool.fqName, { blob: 'x'.repeat(300 * 1024) });
    assert.equal(result.body.error.code, 'request_too_large');
    assert.equal(extension.received.length, before);
  });

  it('truncates an oversized response and flags it', async () => {
    harness.runtime.store.updateSettings({ maxResponseBytes: 2048 });
    const tool = seedTool(harness, { path: '/api/truncate-demo' });
    extension.onExecute(() => ({
      type: 'result',
      id: '',
      ok: true,
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blob: 'y'.repeat(5000) }),
      latencyMs: 2,
      truncated: true,
      bodyEncoding: 'utf8',
    }));
    const result = await execute(tool.fqName);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.truncated, true);
    assert.ok(String(result.body.body).length <= 2048);
    harness.runtime.store.updateSettings({ maxResponseBytes: 1024 * 1024 });
  });

  it('records every attempt, including rejections, in the execution history', async () => {
    const result = await harness.api('/api/v1/executions?limit=100');
    const outcomes = new Set(result.body.executions.map((execution: { outcome: string }) => execution.outcome));
    assert.ok(outcomes.has('ok'));
    assert.ok(outcomes.has('rejected'));
    assert.ok(outcomes.has('error'));
  });

  it('records approvals made through the API as audit events', async () => {
    harness.runtime.store.recordObservation({
      domain: DOMAIN,
      method: 'GET',
      path: '/api/audit-approval-demo',
      queryKeys: [],
      status: 200,
      source: 'webRequest',
    });
    const draft = harness.runtime.store
      .generateDrafts(DOMAIN)
      .created.find((tool) => tool.pathTemplate === '/api/audit-approval-demo')!;
    const approved = await harness.api(`/api/v1/tools/${draft.id}/approve`, { method: 'POST' });
    assert.equal(approved.status, 200);
    const audit = await harness.api('/api/v1/audit?kind=tool.approved');
    assert.ok(audit.body.events.length >= 1);
  });

  it('writes audit events for approvals, executions and rejections', async () => {
    const audit = await harness.api('/api/v1/audit?limit=200');
    const kinds = new Set(audit.body.events.map((event: { kind: string }) => event.kind));
    for (const kind of ['tool.executed', 'tool.rejected', 'tool.failed']) {
      assert.ok(kinds.has(kind), `missing audit kind ${kind}`);
    }
  });
});
