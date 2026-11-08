/**
 * Persistence benchmark.
 *
 * Measures what one tool call costs the store: recording the execution, bumping
 * the tool counters and writing an audit event. Before the audit this path was
 * three synchronous rewrites of the whole state document; now executions and
 * audit events are appended and the document is written lazily.
 *
 *   node tests/bench/store-writes.ts [--count 300]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../../packages/runtime/src/store.ts';

const args = process.argv.slice(2);
const count = Number(args[args.indexOf('--count') + 1]) || 300;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubs-store-bench-'));
const store = Store.open(dir);
store.enableDomain('https://bench.example', 'bench.example');
store.recordObservation({
  origin: 'https://bench.example',
  method: 'GET',
  path: '/api/tasks',
  queryKeys: [],
  status: 200,
  contentType: 'application/json',
  source: 'webRequest',
});
const tool = store.generateDrafts('https://bench.example').created[0];
store.approveTool(tool.id, 'bench');

const started = process.hrtime.bigint();
for (let index = 0; index < count; index += 1) {
  const now = new Date().toISOString();
  store.addExecution({
    id: `exec_${index}`,
    correlationId: `corr_${index}`,
    toolId: tool.id,
    toolName: tool.fqName,
    domain: tool.domain,
    origin: tool.origin,
    method: tool.method,
    path: tool.pathTemplate,
    actor: 'utcp',
    outcome: 'ok',
    httpStatus: 200,
    latencyMs: 5,
    queuedMs: 0,
    startedAt: now,
    finishedAt: now,
    requestBytes: 0,
    responseBytes: 42,
    truncated: false,
    errorCode: null,
    errorCategory: null,
    errorMessage: null,
    permission: 'READ',
    permissionDecision: 'allowed',
    approvalDecision: 'approved',
    responsePreview: '{"items":[]}',
  });
  store.noteToolExecution(tool.id, 'ok');
  store.audit({ kind: 'tool.executed', severity: 'info', actor: 'utcp', origin: tool.origin, toolName: tool.fqName, message: 'bench' });
}
const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
store.close();

const stateBytes = fs.statSync(path.join(dir, 'state.json')).size;
const auditBytes = fs.statSync(path.join(dir, 'audit.ndjson')).size;
const executionBytes = fs.statSync(path.join(dir, 'executions.ndjson')).size;

console.log(
  JSON.stringify(
    {
      calls: count,
      totalMs: Math.round(elapsedMs),
      perCallMs: Math.round((elapsedMs / count) * 1000) / 1000,
      stateBytes,
      auditBytes,
      executionBytes,
      note: 'Three store mutations per call (execution, tool counters, audit event).',
    },
    null,
    2,
  ),
);

fs.rmSync(dir, { recursive: true, force: true });
