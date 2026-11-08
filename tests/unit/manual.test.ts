import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UtcpManualSchema, CallTemplateSerializer } from '@utcp/sdk';
import { Store } from '../../packages/runtime/src/store.ts';
import { buildManual, validateManualDocument, TOKEN_VARIABLE } from '../../packages/runtime/src/manual.ts';
import { registerBrowserSessionProtocol, BrowserSessionCallTemplateSerializer } from '../../packages/provider/src/index.ts';

// The SDK validates call templates through its registry, so the transport must
// be registered before a manual containing it can be parsed.
registerBrowserSessionProtocol();

function tmpStore(): Store {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubs-manual-'));
  return Store.open(dir);
}

function seed(store: Store) {
  store.enableDomain('example.com', { origin: 'https://example.com' });
  const endpoint = store.recordObservation({
    domain: 'example.com',
    method: 'GET',
    path: '/api/tasks',
    queryKeys: ['status'],
    status: 200,
    contentType: 'application/json',
    source: 'webRequest',
  });
  const { created } = store.generateDrafts('example.com');
  return { endpoint, tool: created[0] };
}

describe('buildManual', () => {
  it('only lists approved tools and never embeds a secret', () => {
    const store = tmpStore();
    const { tool } = seed(store);

    const before = buildManual(store, { manualName: 'browser', runtimeUrl: 'http://127.0.0.1:8777' });
    assert.equal(before.tools.length, 0, 'draft tools must not appear in the manual');

    store.approveTool(tool.id, 'test');
    const after = buildManual(store, { manualName: 'browser', runtimeUrl: 'http://127.0.0.1:8777' });

    assert.equal(after.tools.length, 1);
    const entry = after.tools[0];
    assert.equal(entry.name, 'browser.list_tasks');
    assert.equal(entry.tool_call_template.call_template_type, 'utcp_browser_session');
    assert.equal(entry.tool_call_template.pairing_token, `\${${TOKEN_VARIABLE}}`);

    const serialized = JSON.stringify(after);
    assert.ok(!serialized.includes('Bearer'));
    assert.ok(!/eyJ[A-Za-z0-9_-]{8,}\./.test(serialized));
  });

  it('is accepted by the official SDK schema', () => {
    const store = tmpStore();
    const { tool } = seed(store);
    store.approveTool(tool.id, 'test');
    const manual = buildManual(store, { manualName: 'browser', runtimeUrl: 'http://127.0.0.1:8777' });

    const parsed = UtcpManualSchema.parse(manual);
    assert.equal(parsed.tools.length, 1);
    assert.equal(parsed.tools[0].tool_call_template.call_template_type, 'utcp_browser_session');
    assert.equal(parsed.utcp_version, '1.0');
  });

  it('round-trips through our registered call-template serializer', () => {
    registerBrowserSessionProtocol();
    const store = tmpStore();
    const { tool } = seed(store);
    store.approveTool(tool.id, 'test');
    const manual = buildManual(store, { manualName: 'browser', runtimeUrl: 'http://127.0.0.1:8777' });

    const serializer = new BrowserSessionCallTemplateSerializer();
    const dict = serializer.toDict(manual.tools[0].tool_call_template as never);
    const back = serializer.validateDict(dict as Record<string, unknown>);
    assert.equal((back as Record<string, unknown>).tool, 'browser.list_tasks');

    const viaRegistry = new CallTemplateSerializer().validateDict(dict as Record<string, unknown>);
    assert.equal((viaRegistry as Record<string, unknown>).call_template_type, 'utcp_browser_session');
  });
});

describe('validateManualDocument', () => {
  it('accepts a generated manual', () => {
    const store = tmpStore();
    const { tool } = seed(store);
    store.approveTool(tool.id, 'test');
    const manual = buildManual(store, { manualName: 'browser', runtimeUrl: 'http://127.0.0.1:8777' });
    const report = validateManualDocument(manual, 'browser');
    assert.equal(report.ok, true, report.errors.join(' '));
    assert.equal(report.toolCount, 1);
  });

  it('rejects a literal token, wrong transport and bad namespacing', () => {
    const manual = {
      utcp_version: '1.0',
      manual_version: '1.0',
      tools: [
        {
          name: 'other.list_tasks',
          description: 'x',
          inputs: { type: 'object' },
          outputs: { type: 'object' },
          tags: [],
          tool_call_template: {
            name: 'other',
            call_template_type: 'http',
            runtime_url: 'http://127.0.0.1:8777',
            pairing_token: 'Bearer sk-live-abcdef',
            tool: 'x',
            path_template: '/api',
          },
        },
      ],
    };
    const report = validateManualDocument(manual as never, 'browser');
    assert.equal(report.ok, false);
    const joined = report.errors.join(' ');
    assert.match(joined, /call_template_type/);
    assert.match(joined, /not namespaced/);
    assert.match(joined, /variable, not a literal/);
    assert.match(joined, /credential material/);
  });

  it('detects cookie material smuggled into a description', () => {
    const store = tmpStore();
    const { tool } = seed(store);
    store.approveTool(tool.id, 'test');
    const manual = buildManual(store, { manualName: 'browser', runtimeUrl: 'http://127.0.0.1:8777' });
    manual.tools[0].description = 'debug sid=deadbeefcafe';
    const report = validateManualDocument(manual, 'browser');
    assert.equal(report.ok, false);
    assert.match(report.errors.join(' '), /credential material/);
  });
});
