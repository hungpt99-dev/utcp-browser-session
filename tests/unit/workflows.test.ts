import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../../packages/runtime/src/store.ts';
import { discoverWorkflows } from '../../packages/runtime/src/workflows.ts';
import type { ExecutionRecord, ToolRecord } from '../../packages/shared/src/protocol.ts';

const ORIGIN = 'https://app.example.com';

function execution(tool: ToolRecord, at: number): ExecutionRecord {
  return {
    id: `exec_${at}`,
    correlationId: `corr_${at}`,
    toolId: tool.id,
    toolName: tool.fqName,
    domain: tool.domain,
    origin: tool.origin,
    method: tool.method,
    path: tool.pathTemplate,
    actor: 'utcp',
    outcome: 'ok',
    httpStatus: 200,
    latencyMs: 12,
    queuedMs: 0,
    startedAt: new Date(at).toISOString(),
    finishedAt: new Date(at + 12).toISOString(),
    requestBytes: 10,
    responseBytes: 40,
    truncated: false,
    errorCode: null,
    errorCategory: null,
    errorMessage: null,
    permission: tool.permission,
    permissionDecision: 'allowed',
    approvalDecision: 'approved',
    responsePreview: null,
  };
}

function seed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubs-wf-'));
  const store = Store.open(dir);
  store.enableDomain(ORIGIN, 'app.example.com');
  store.recordObservation({
    origin: ORIGIN,
    method: 'GET',
    path: '/api/issues/42',
    queryKeys: [],
    status: 200,
    contentType: 'application/json',
    source: 'webRequest',
    responseShape: { type: 'object', properties: { id: { type: 'number' }, title: { type: 'string' } } },
  });
  store.recordObservation({
    origin: ORIGIN,
    method: 'POST',
    path: '/api/issues/42/comments',
    queryKeys: [],
    status: 201,
    contentType: 'application/json',
    source: 'webRequest',
    requestShape: { type: 'object', properties: { id: { type: 'number' }, body: { type: 'string' } } },
    responseShape: { type: 'object', properties: { id: { type: 'number' } } },
  });
  const created = store.generateDrafts(ORIGIN).created;
  for (const tool of created) store.approveTool(tool.id, 'test');
  const read = created.find((tool) => tool.method === 'GET')!;
  const comment = created.find((tool) => tool.method === 'POST')!;
  return { store, dir, read, comment };
}

describe('workflow discovery', () => {
  it('proposes a sequence only after it is observed more than once', () => {
    const { store, dir, read, comment } = seed();
    const base = Date.now() - 60_000;

    store.addExecution(execution(read, base));
    assert.equal(discoverWorkflows(store).length, 0, 'one pass is not a pattern');

    store.addExecution(execution(comment, base + 4000));
    store.addExecution(execution(read, base + 30_000));
    store.addExecution(execution(comment, base + 34_000));

    const proposals = discoverWorkflows(store);
    assert.equal(proposals.length >= 1, true);
    const workflow = proposals[0];
    assert.deepEqual(workflow.steps.map((step) => step.toolName), [read.fqName, comment.fqName]);
    assert.equal(workflow.occurrences >= 2, true);
    assert.equal(workflow.status, 'draft', 'proposals are never auto-published');
    assert.equal(workflow.origin, ORIGIN);

    // `id` is both a response field of step 1 and an input of step 2.
    const binding = workflow.steps[1].bindings.find((candidate) => candidate.input === 'id');
    assert.ok(binding, 'the shared identifier is bound');
    assert.equal(binding?.fromStep, 0);

    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not join calls that are far apart in time', () => {
    const { store, dir, read, comment } = seed();
    const base = Date.now() - 3_600_000;
    store.addExecution(execution(read, base));
    store.addExecution(execution(comment, base + 10 * 60_000));
    store.addExecution(execution(read, base + 20 * 60_000));
    store.addExecution(execution(comment, base + 30 * 60_000));
    assert.equal(discoverWorkflows(store).length, 0, 'a 10 minute gap is a separate session');
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('marks destructive steps', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubs-wf2-'));
    const store = Store.open(dir);
    store.enableDomain(ORIGIN, 'app.example.com');
    for (const [method, pathTemplate] of [
      ['GET', '/api/issues/42'],
      ['DELETE', '/api/issues/42'],
    ] as const) {
      store.recordObservation({
        origin: ORIGIN,
        method,
        path: pathTemplate,
        queryKeys: [],
        status: 200,
        contentType: 'application/json',
        source: 'webRequest',
      });
    }
    const created = store.generateDrafts(ORIGIN).created;
    for (const tool of created) store.approveTool(tool.id, 'test');
    const read = created.find((tool) => tool.method === 'GET')!;
    const destroy = created.find((tool) => tool.method === 'DELETE')!;
    const base = Date.now() - 60_000;
    for (let round = 0; round < 2; round += 1) {
      store.addExecution(execution(read, base + round * 20_000));
      store.addExecution(execution(destroy, base + round * 20_000 + 1000));
    }
    const proposals = discoverWorkflows(store);
    const workflow = proposals.find((candidate) => candidate.steps.some((step) => step.destructive));
    assert.ok(workflow, 'the destructive step is flagged');
    assert.equal(workflow!.steps.at(-1)?.destructive, true);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
