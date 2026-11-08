import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  Stack,
  Typography,
} from '@mui/material';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHighOutlined';
import type { Api } from '../api.ts';
import type { WorkflowProposal } from '@utcp-browser-session/shared';
import { EmptyState, SectionHeader } from '../components.tsx';

const STATUS_COLOR: Record<WorkflowProposal['status'], 'default' | 'success' | 'warning'> = {
  draft: 'warning',
  approved: 'success',
  rejected: 'default',
};

/**
 * Workflow proposals derived from execution history.
 *
 * Nothing here is executable by design: a workflow is a document a human
 * approves, and every step still runs as its own tool with its own permission
 * check and confirmation rules.
 */
export default function Workflows({ api }: { api: Api }) {
  const [workflows, setWorkflows] = useState<WorkflowProposal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await api.workflows();
    setWorkflows(result.workflows);
  }, [api]);

  useEffect(() => {
    void load().catch((cause) => setError(cause instanceof Error ? cause.message : 'Failed to load workflows.'));
  }, [load]);

  const discover = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.discoverWorkflows();
      setNotice(
        result.proposals.length
          ? `${result.proposals.length} proposal(s) from recorded history. Nothing was published.`
          : 'No repeated sequence found yet. Run the same tools together a couple of times first.',
      );
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Discovery failed.');
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (id: string, action: 'approve' | 'reject') => {
    try {
      await api.setWorkflowStatus(id, action);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update the workflow.');
    }
  };

  return (
    <Box>
      <SectionHeader
        title="Workflows"
        subtitle="Repeated tool sequences found in the execution history. Proposals only — a workflow never runs on its own."
      />

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {notice && (
        <Alert severity="info" sx={{ mb: 2 }} onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      )}

      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Stack direction="row" spacing={1.5} alignItems="center">
            <Box sx={{ flex: 1 }}>
              <Typography sx={{ fontWeight: 650 }}>Discover from history</Typography>
              <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
                Looks for the same ordered sequence of approved tools, on one origin, at least twice.
                Parameter bindings are inferred only when a later input matches an earlier response field.
              </Typography>
            </Box>
            <Button variant="contained" startIcon={<AutoFixHighIcon />} disabled={busy} onClick={() => void discover()}>
              {busy ? 'Analysing…' : 'Analyse history'}
            </Button>
          </Stack>
        </CardContent>
      </Card>

      {workflows.length === 0 ? (
        <Card>
          <EmptyState
            title="No proposals yet"
            body="Workflows appear once the same tools have been called together, in the same order, at least twice."
          />
        </Card>
      ) : (
        <Stack spacing={1.5}>
          {workflows.map((workflow) => (
            <Card key={workflow.id}>
              <CardContent>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                  <Typography sx={{ fontWeight: 650, flex: 1 }}>{workflow.name}</Typography>
                  <Chip size="small" label={workflow.status} color={STATUS_COLOR[workflow.status]} sx={{ height: 19, fontSize: 10 }} />
                  <Chip size="small" variant="outlined" label={`${workflow.occurrences}×`} sx={{ height: 19, fontSize: 10 }} />
                  <Chip size="small" variant="outlined" label={`${Math.round(workflow.confidence * 100)}% confidence`} sx={{ height: 19, fontSize: 10 }} />
                </Stack>
                <Typography sx={{ fontSize: 11.5, color: 'text.secondary', mb: 1 }}>
                  {workflow.origin} · {workflow.summary}
                </Typography>

                <Divider sx={{ mb: 1 }} />
                <Stack spacing={0.75}>
                  {workflow.steps.map((step, index) => (
                    <Box key={`${workflow.id}-${index}`}>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Typography sx={{ fontSize: 11, color: 'text.secondary', width: 18 }}>{index + 1}</Typography>
                        <Typography sx={{ fontSize: 12.5, fontFamily: 'ui-monospace, Menlo, monospace' }}>
                          {step.toolName}
                        </Typography>
                        {step.destructive && (
                          <Chip size="small" color="error" variant="outlined" label="destructive" sx={{ height: 18, fontSize: 9.5 }} />
                        )}
                      </Stack>
                      {step.bindings.length > 0 && (
                        <Typography sx={{ fontSize: 11, color: 'text.secondary', ml: 3.5 }}>
                          {step.bindings.map((binding) => `${binding.input} ← step ${binding.fromStep + 1}.${binding.outputPath}`).join(' · ')}
                        </Typography>
                      )}
                    </Box>
                  ))}
                </Stack>

                {workflow.status === 'draft' && (
                  <Stack direction="row" spacing={1} sx={{ mt: 1.25 }}>
                    <Button size="small" variant="contained" onClick={() => void setStatus(workflow.id, 'approve')}>
                      Approve
                    </Button>
                    <Button size="small" variant="text" color="inherit" onClick={() => void setStatus(workflow.id, 'reject')}>
                      Reject
                    </Button>
                  </Stack>
                )}
              </CardContent>
            </Card>
          ))}
        </Stack>
      )}
    </Box>
  );
}
