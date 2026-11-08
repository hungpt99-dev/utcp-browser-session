/**
 * Workflow discovery (optional, metadata only).
 *
 * Replays the runtime's own execution history to find sequences of tools that
 * were called together, in the same order, on the same origin. A sequence is
 * only proposed when it was observed at least twice, and it is never executed:
 * a proposal is a document a human can approve, edit or ignore.
 *
 * Parameter bindings are inferred structurally — a step's input is bound to a
 * previous step's output only when the names match and the previous step's
 * observed response schema actually contains that field. No values are involved.
 */
import { randomUUID } from 'node:crypto';
import type { ExecutionRecord, ToolRecord, WorkflowProposal, WorkflowStep } from '@utcp-browser-session/shared';
import type { Store } from './store.ts';

const MAX_SEQUENCE = 5;
const MIN_SEQUENCE = 2;
const MIN_OCCURRENCES = 2;
const SESSION_GAP_MS = 5 * 60_000;
const MAX_EXECUTIONS = 500;

interface Run {
  toolName: string;
  toolId: string;
  origin: string;
  at: number;
}

function sequencesOf(runs: Run[]): Map<string, { steps: Run[]; occurrences: number }> {
  const counts = new Map<string, { steps: Run[]; occurrences: number }>();
  let window: Run[] = [];

  const flush = (): void => {
    for (let size = MIN_SEQUENCE; size <= Math.min(MAX_SEQUENCE, window.length); size += 1) {
      for (let start = 0; start + size <= window.length; start += 1) {
        const slice = window.slice(start, start + size);
        const names = slice.map((run) => run.toolName);
        // A sequence of one repeated tool is a loop, not a workflow.
        if (new Set(names).size < 2) continue;
        const key = `${slice[0].origin}|${names.join('>')}`;
        const existing = counts.get(key);
        if (existing) existing.occurrences += 1;
        else counts.set(key, { steps: slice, occurrences: 1 });
      }
    }
    window = [];
  };

  for (const run of runs) {
    const previous = window[window.length - 1];
    if (previous && (run.origin !== previous.origin || run.at - previous.at > SESSION_GAP_MS)) flush();
    window.push(run);
    if (window.length > 20) window = window.slice(-10);
  }
  flush();
  return counts;
}

function bindingsFor(
  step: ToolRecord,
  previous: Array<{ tool: ToolRecord; index: number }>,
): WorkflowStep['bindings'] {
  const bindings: WorkflowStep['bindings'] = [];
  for (const input of Object.keys(step.inputSchema.properties ?? {})) {
    for (const candidate of previous.slice().reverse()) {
      const outputs = candidate.tool.outputSchema;
      const properties = outputs && typeof outputs === 'object' ? (outputs.properties ?? {}) : {};
      const hasField = Object.prototype.hasOwnProperty.call(properties, input);
      // Only bind when the earlier tool is documented to return this field.
      if (hasField) {
        bindings.push({ input, fromStep: candidate.index, outputPath: input });
        break;
      }
    }
  }
  return bindings;
}

/** Derive human-editable proposals from the recorded execution history. */
export function discoverWorkflows(store: Store): WorkflowProposal[] {
  const executions: ExecutionRecord[] = store
    .listExecutions(MAX_EXECUTIONS)
    .slice()
    .reverse()
    .filter((execution) => execution.outcome === 'ok' && execution.toolId);

  const byId = new Map<string, ToolRecord>();
  for (const tool of store.listTools()) byId.set(tool.id, tool);

  const runs: Run[] = [];
  for (const execution of executions) {
    const tool = byId.get(execution.toolId);
    if (!tool) continue;
    runs.push({
      toolName: tool.fqName,
      toolId: tool.id,
      origin: tool.origin,
      at: new Date(execution.startedAt).getTime(),
    });
  }

  const sequences = sequencesOf(runs);
  const proposals: WorkflowProposal[] = [];
  for (const [key, entry] of sequences) {
    if (entry.occurrences < MIN_OCCURRENCES) continue;
    const tools = entry.steps.map((step) => byId.get(step.toolId)).filter((tool): tool is ToolRecord => Boolean(tool));
    if (tools.length !== entry.steps.length) continue;

    const steps: WorkflowStep[] = tools.map((tool, index) => ({
      toolId: tool.id,
      toolName: tool.fqName,
      bindings: bindingsFor(
        tool,
        tools.slice(0, index).map((previous, previousIndex) => ({ tool: previous, index: previousIndex })),
      ),
      destructive: tool.permission === 'DESTRUCTIVE',
    }));

    const names = tools.map((tool) => tool.name.replace(/_/g, ' '));
    const first = tools[0];
    const bound = steps.reduce((total, step) => total + step.bindings.length, 0);
    proposals.push({
      id: `wf_${randomUUID().slice(0, 8)}`,
      name: names.slice(0, 3).join(' then ').slice(0, 70),
      summary: `${steps.length} steps on ${first.origin}; observed ${entry.occurrences} times.${bound > 0 ? ` ${bound} parameter binding(s) inferred.` : ' No parameter bindings were inferred, so every step needs its own inputs.'}`,
      origin: first.origin,
      domain: first.domain,
      steps,
      occurrences: entry.occurrences,
      confidence: Math.min(1, Math.round((entry.occurrences / 4) * (bound > 0 ? 1 : 0.8) * 100) / 100),
      status: 'draft',
      createdAt: new Date().toISOString(),
      approvedAt: null,
    });
    void key;
  }

  // Keep the strongest proposals, newest first, without duplicates.
  const unique = new Map<string, WorkflowProposal>();
  for (const proposal of proposals) {
    const existing = unique.get(proposal.name);
    if (!existing || proposal.occurrences > existing.occurrences) unique.set(proposal.name, proposal);
  }
  return [...unique.values()]
    .sort((a, b) => b.occurrences - a.occurrences || b.steps.length - a.steps.length)
    .slice(0, 20);
}
