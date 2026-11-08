import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  Chip,
  Divider,
  Drawer,
  IconButton,
  MenuItem,
  Select,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/CloseOutlined';
import CheckIcon from '@mui/icons-material/CheckCircleOutline';
import BlockIcon from '@mui/icons-material/BlockOutlined';
import BoltIcon from '@mui/icons-material/BoltOutlined';
import type { Api } from '../api.ts';
import type { ToolRecord } from '@utcp-browser-session/shared';
import { EmptyState, JsonBlock, KeyValue, MethodChip, PermissionChip, SectionHeader, StatusChip } from '../components.tsx';

export default function Tools({
  api,
  initialToolId,
  onChanged,
}: {
  api: Api;
  initialToolId: string | null;
  onChanged: () => void;
}) {
  const [tools, setTools] = useState<ToolRecord[]>([]);
  const [filter, setFilter] = useState<'all' | 'draft' | 'approved' | 'revoked'>('all');
  const [selected, setSelected] = useState<string | null>(initialToolId);
  const [tab, setTab] = useState(0);
  const [args, setArgs] = useState('{}');
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await api.tools();
    setTools(result.tools);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (initialToolId) setSelected(initialToolId);
  }, [initialToolId]);

  const filtered = useMemo(
    () => (filter === 'all' ? tools : tools.filter((tool) => tool.status === filter)),
    [tools, filter],
  );

  const tool = tools.find((candidate) => candidate.id === selected) ?? null;

  useEffect(() => {
    if (!tool) return;
    const example: Record<string, unknown> = {};
    for (const [name, schema] of Object.entries((tool.inputSchema.properties ?? {}) as Record<string, { type?: string }>)) {
      example[name] = schema.type === 'number' || schema.type === 'integer' ? 1 : schema.type === 'boolean' ? true : '';
    }
    setArgs(JSON.stringify(example, null, 2));
    setResult(null);
    setError(null);
    setTab(0);
  }, [tool?.id]);

  const approve = async () => {
    if (!tool) return;
    setBusy(true);
    try {
      await api.approve(tool.id);
      await load();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Approval failed.');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!tool) return;
    await api.revoke(tool.id);
    await load();
    onChanged();
  };

  const run = async () => {
    if (!tool) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const parsed = JSON.parse(args || '{}') as Record<string, unknown>;
      const response = await api.execute({ tool: tool.fqName, args: parsed, confirm });
      setResult(response);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Execution failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box>
      <SectionHeader
        title="Tools"
        subtitle="Generated from discovered endpoints. Nothing executes until it is approved."
        action={
          <Select size="small" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)} sx={{ minWidth: 150 }}>
            <MenuItem value="all">All tools</MenuItem>
            <MenuItem value="draft">Awaiting review</MenuItem>
            <MenuItem value="approved">Approved</MenuItem>
            <MenuItem value="revoked">Revoked</MenuItem>
          </Select>
        }
      />

      <Card>
        {filtered.length === 0 ? (
          <EmptyState
            title="No tools here"
            body="Enable a site, run discovery, then press “Generate drafts” on the website card."
          />
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Tool</TableCell>
                <TableCell>Endpoint</TableCell>
                <TableCell>Permission</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right">Calls</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filtered.map((item) => (
                <TableRow
                  key={item.id}
                  hover
                  selected={item.id === selected}
                  onClick={() => setSelected(item.id)}
                  sx={{ cursor: 'pointer' }}
                >
                  <TableCell>
                    <Typography sx={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }}>{item.fqName}</Typography>
                    <Typography
                      sx={{
                        fontSize: 11,
                        color: 'text.secondary',
                        maxWidth: 360,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {item.description}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.75} alignItems="center">
                      <MethodChip method={item.method} />
                      <Typography sx={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11.5 }}>{item.pathTemplate}</Typography>
                    </Stack>
                  </TableCell>
                  <TableCell><PermissionChip permission={item.permission} /></TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.5}>
                      <StatusChip status={item.status} />
                      {item.reviewRequired && <Chip size="small" label="review" sx={{ height: 19, fontSize: 9.5 }} color="warning" variant="outlined" />}
                    </Stack>
                  </TableCell>
                  <TableCell align="right" sx={{ fontSize: 12 }}>{item.executionCount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Drawer
        anchor="right"
        open={!!tool}
        onClose={() => setSelected(null)}
        PaperProps={{ sx: { width: { xs: '100%', sm: 620 }, backgroundColor: '#0d1424', backgroundImage: 'none' } }}
      >
        {tool && (
          <Box sx={{ p: 2.5 }}>
            <Stack direction="row" alignItems="flex-start" spacing={1}>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="h6" sx={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 16 }}>
                  {tool.fqName}
                </Typography>
                <Typography sx={{ fontSize: 12.5, color: 'text.secondary', mt: 0.5 }}>{tool.description}</Typography>
              </Box>
              <IconButton size="small" onClick={() => setSelected(null)}>
                <CloseIcon fontSize="small" />
              </IconButton>
            </Stack>

            <Stack direction="row" spacing={0.75} sx={{ mt: 1.5 }}>
              <MethodChip method={tool.method} />
              <PermissionChip permission={tool.permission} />
              <StatusChip status={tool.status} />
              {tool.discovery.sources.map((source) => (
                <Chip key={source} size="small" label={source} sx={{ height: 20, fontSize: 10 }} variant="outlined" />
              ))}
            </Stack>

            <Divider sx={{ my: 2 }} />

            <Stack spacing={0.25}>
              <KeyValue label="Endpoint">
                <code>{`${tool.method} ${tool.pathTemplate}`}</code>
              </KeyValue>
              <KeyValue label="Domain">{tool.domain}</KeyValue>
              <KeyValue label="Samples">{tool.discovery.sampleCount} observation(s)</KeyValue>
              <KeyValue label="Observed">{tool.discovery.statusCodes.join(', ') || 'no status recorded'}</KeyValue>
              <KeyValue label="Approved">{tool.approvedAt ? `${new Date(tool.approvedAt).toLocaleString()} by ${tool.approvedBy}` : 'not approved'}</KeyValue>
              <KeyValue label="Parameters">
                {Object.entries(tool.paramLocations).map(([name, location]) => `${name}:${location}`).join(', ') || 'none'}
              </KeyValue>
            </Stack>

            <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
              <Button
                variant="contained"
                startIcon={<CheckIcon />}
                disabled={busy || tool.status === 'approved'}
                onClick={() => void approve()}
              >
                {tool.status === 'approved' ? 'Approved' : 'Approve tool'}
              </Button>
              <Button variant="outlined" color="error" startIcon={<BlockIcon />} disabled={tool.status === 'revoked'} onClick={() => void revoke()}>
                Revoke
              </Button>
            </Stack>

            <Tabs value={tab} onChange={(_event, value) => setTab(value)} sx={{ mt: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
              <Tab label="Input schema" sx={{ textTransform: 'none' }} />
              <Tab label="Output schema" sx={{ textTransform: 'none' }} />
              <Tab label="Test call" sx={{ textTransform: 'none' }} />
            </Tabs>

            <Box sx={{ pt: 2 }}>
              {tab === 0 && <JsonBlock value={tool.inputSchema} maxHeight={340} />}
              {tab === 1 && <JsonBlock value={tool.outputSchema} maxHeight={340} />}
              {tab === 2 && (
                <Box>
                  <TextField
                    fullWidth
                    multiline
                    minRows={5}
                    size="small"
                    label="Arguments (JSON)"
                    value={args}
                    onChange={(event) => setArgs(event.target.value)}
                    sx={{ fontFamily: 'ui-monospace, Menlo, monospace' }}
                  />
                  {tool.permission === 'DESTRUCTIVE' && (
                    <Alert severity="warning" sx={{ mt: 1, py: 0.25 }}>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Typography sx={{ fontSize: 12.5 }}>Destructive operation — requires explicit confirmation.</Typography>
                        <Button size="small" variant={confirm ? 'contained' : 'outlined'} color="warning" onClick={() => setConfirm(!confirm)}>
                          {confirm ? 'Confirmed' : 'Confirm'}
                        </Button>
                      </Stack>
                    </Alert>
                  )}
                  <Button
                    sx={{ mt: 1.25 }}
                    variant="contained"
                    startIcon={<BoltIcon />}
                    disabled={busy || tool.status !== 'approved'}
                    onClick={() => void run()}
                  >
                    {busy ? 'Running…' : 'Execute through the browser'}
                  </Button>
                  {tool.status !== 'approved' && (
                    <Typography sx={{ fontSize: 11.5, color: 'text.secondary', mt: 1 }}>
                      Approve the tool before executing it.
                    </Typography>
                  )}
                  {error && (
                    <Alert severity="error" sx={{ mt: 1.5 }}>
                      {error}
                    </Alert>
                  )}
                  {result != null && <Box sx={{ mt: 1.5 }}><JsonBlock value={result} maxHeight={320} /></Box>}
                </Box>
              )}
            </Box>
          </Box>
        )}
      </Drawer>
    </Box>
  );
}
