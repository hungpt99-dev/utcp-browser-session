import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, enableFixtureDomain, type Harness } from '../helpers/harness.ts';
import { FakeExtension } from '../helpers/fake-extension.ts';
import { buildManual } from '../../packages/runtime/src/manual.ts';

const SESSION_SECRET = 'sid=SUPER-SECRET-SESSION-9f3a';
const BEARER_SECRET = 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZ2VudCJ9.c2lnbmF0dXJlLXZhbHVl';

/**
 * AC-09: nothing that identifies a browser session may reach the runtime's
 * response envelope, its state file, its audit log or a generated manual.
 */
describe('credential leak prevention', () => {
  let harness: Harness;
  let extension: FakeExtension;
  let envelopeText = '';

  before(async () => {
    harness = await createHarness();
    await enableFixtureDomain(harness);
    extension = await FakeExtension.pair({ runtimeUrl: harness.runtime.url, token: harness.runtime.token });
    await extension.connect();
    await extension.waitForSync();

    // The most hostile answer a compromised site (or a buggy proxy) could give.
    extension.onExecute(() => ({
      type: 'result',
      id: '',
      ok: true,
      status: 200,
      headers: {
        'content-type': 'application/json',
        'set-cookie': `${SESSION_SECRET}; Path=/; HttpOnly`,
        'x-auth-token': 'token=ABCDEF123456',
      },
      body: JSON.stringify({ tasks: [], echoed: 'Bearer should-not-be-logged-abcdefghijklmnop' }),
      latencyMs: 3,
      truncated: false,
      bodyEncoding: 'utf8',
    }));

    harness.runtime.store.recordObservation({
      origin: harness.site.origin,
      method: 'GET',
      path: '/api/tasks',
      queryKeys: [],
      status: 200,
      contentType: 'application/json',
      source: 'webRequest',
    });
    const tool = harness.runtime.store.generateDrafts(harness.site.origin).created[0];
    harness.runtime.store.approveTool(tool.id, 'test');

    const response = await harness.api('/api/v1/execute', {
      method: 'POST',
      body: JSON.stringify({ tool: tool.fqName, args: {}, confirm: false }),
    });
    envelopeText = JSON.stringify(response.body);
    assert.equal(response.body.ok, true);
  });

  after(async () => {
    extension.close();
    await harness.close();
  });

  it('never returns set-cookie or authorization headers to the caller', () => {
    assert.equal(envelopeText.includes('set-cookie'), false);
    assert.equal(envelopeText.includes(SESSION_SECRET), false);
    assert.equal(envelopeText.includes('x-auth-token'), false);
  });

  it('keeps the session secret out of the persisted runtime state', () => {
    const stateFile = path.join(harness.dataDir, 'state.json');
    const raw = fs.readFileSync(stateFile, 'utf8');
    assert.equal(raw.includes('SUPER-SECRET-SESSION'), false);
    assert.equal(raw.includes('ABCDEF123456'), false);
  });

  it('redacts token-shaped values in stored response previews', async () => {
    const executions = await harness.api('/api/v1/executions');
    const preview = JSON.stringify(executions.body.executions[0].responsePreview ?? '');
    assert.equal(preview.includes('should-not-be-logged'), false);
    assert.match(preview, /\[REDACTED\]/);
  });

  it('keeps credentials out of the audit trail', async () => {
    const audit = await harness.api('/api/v1/audit?limit=200');
    const text = JSON.stringify(audit.body);
    for (const secret of ['SUPER-SECRET-SESSION', 'ABCDEF123456', BEARER_SECRET, 'should-not-be-logged']) {
      assert.equal(text.includes(secret), false, `audit leaked ${secret.slice(0, 12)}`);
    }
  });

  it('generates a manual that references the token as a variable only', () => {
    const manual = buildManual(harness.runtime.store, {
      manualName: 'browser',
      runtimeUrl: harness.runtime.url,
    });
    const text = JSON.stringify(manual);
    assert.equal(text.includes(harness.runtime.token), false, 'the runtime bearer token must not be in the manual');
    assert.match(text, /\$\{UTCP_BROWSER_SESSION_TOKEN\}/);
    assert.equal(text.includes('SUPER-SECRET-SESSION'), false);
  });

  it('does not log the runtime token in the state file', () => {
    const raw = fs.readFileSync(path.join(harness.dataDir, 'state.json'), 'utf8');
    assert.equal(raw.includes(harness.runtime.token), false);
  });
});
