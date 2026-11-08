import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Divider,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopyOutlined';
import type { Api, RuntimeStatus } from '../api.ts';
import type { ExecutionRecord, ToolRecord } from '@utcp-browser-session/shared';
import { EmptyState, KeyValue, MethodChip, PermissionChip, SectionHeader, StatCard, StatusChip } from '../components.tsx';

export default function Overview({
  api,
  status,
  onNavigate,
  onSelectTool,
}: {
  api: Api;
  status: RuntimeStatus;
  onNavigate: (view: 'websites' | 'tools' | 'executions') => void;
  onSelectTool: (id: string) => void;
}) {
  const [executions, setExecutions] = useState<ExecutionRecord[]>([]);
  const [drafts, setDrafts] = useState<ToolRecord[]>([]);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void api.executions(6).then((result) => setExecutions(result.executions)).catch(() => undefined);
    void api.tools('draft').then((result) => setDrafts(result.tools)).catch(() => undefined);
  }, [api, status.stats.executions, status.stats.drafts]);

  const connection = status.connection;

  return (
    <Box>
      <SectionHeader
        title="Overview"
        subtitle="One runtime, one browser session, every approved website capability."
      />

      <Stack direction="row" spacing={2} sx={{ mb: 2, flexWrap: 'wrap', rowGap: 2 }}>
        <StatCard
          label="Browser"
          value={connection.connected ? 'Connected' : 'Offline'}
          hint={connection.client?.label ?? 'pair the extension'}
          accent={connection.connected ? 'success.main' : 'warning.main'}
        />
        <StatCard label="Enabled sites" value={status.stats.enabledDomains} hint={`${status.stats.domains} known`} />
        <StatCard label="Discovered APIs" value={status.stats.endpoints} hint="method + path pairs" />
        <StatCard label="Approved tools" value={status.stats.approved} hint={`${status.stats.drafts} awaiting review`} accent="#60a5fa" />
        <StatCard label="Executions" value={status.stats.executions} hint="recorded in this runtime" />
      </Stack>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1.35fr 1fr' }, gap: 2 }}>
        <Card>
          <CardContent>
            <SectionHeader
              title="Recent executions"
              subtitle="Sanitized metadata only — cookies and authorization headers are never stored."
              action={
                <Button size="small" onClick={() => onNavigate('executions')}>
                  View all
                </Button>
              }
            />
            {executions.length === 0 ? (
              <EmptyState
                title="No executions yet"
                body="Approve a discovered tool, then call it from a UTCP client or from the tool inspector."
              />
            ) : (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Tool</TableCell>
                    <TableCell>Outcome</TableCell>
                    <TableCell align="right">HTTP</TableCell>
                    <TableCell align="right">Latency</TableCell>
                    <TableCell>When</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {executions.map((execution) => (
                    <TableRow key={execution.id} hover>
                      <TableCell sx={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11.5 }}>{execution.toolName}</TableCell>
                      <TableCell>
                        <StatusChip status={execution.outcome} />
                      </TableCell>
                      <TableCell align="right" sx={{ fontSize: 12 }}>{execution.httpStatus ?? '—'}</TableCell>
                      <TableCell align="right" sx={{ fontSize: 12 }}>{execution.latencyMs ? `${Math.round(execution.latencyMs)} ms` : '—'}</TableCell>
                      <TableCell sx={{ fontSize: 11.5, color: 'text.secondary' }}>
                        {new Date(execution.startedAt).toLocaleTimeString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Stack spacing={2}>
          <Card>
            <CardContent>
              <SectionHeader title="Browser connection" subtitle="Pair once per Chrome profile." />
              <KeyValue label="Status">
                <Stack direction="row" spacing={1} alignItems="center">
                  <Box
                    sx={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      backgroundColor: connection.connected ? 'success.main' : 'warning.main',
                    }}
                  />
                  {connection.connected ? 'Websocket authenticated' : 'Waiting for the extension'}
                </Stack>
              </KeyValue>
              <KeyValue label="Client">{connection.client?.clientId ?? '—'}</KeyValue>
              <KeyValue label="Connected at">
                {connection.client ? new Date(connection.client.connectedAt).toLocaleString() : '—'}
              </KeyValue>
              <KeyValue label="Capturing">{connection.capturing.length ? connection.capturing.join(', ') : 'idle'}</KeyValue>
              <KeyValue label="Messages">{`${connection.counters.discoveryFrames} discovery frames · ${connection.counters.observationsIngested} endpoints ingested`}</KeyValue>
              <Divider sx={{ my: 1.5 }} />
              {pairing ? (
                <Alert severity="info" icon={false} sx={{ alignItems: 'flex-start' }}>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Typography sx={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 20, letterSpacing: '0.16em' }}>
                      {pairing.code}
                    </Typography>
                    <Button
                      size="small"
                      startIcon={<ContentCopyIcon fontSize="small" />}
                      onClick={() => {
                        void navigator.clipboard?.writeText(pairing.code);
                        setCopied(true);
                      }}
                    >
                      {copied ? 'Copied' : 'Copy'}
                    </Button>
                  </Stack>
                  <Typography sx={{ fontSize: 11.5, mt: 0.5 }}>
                    Open the extension popup, paste this code, and pair. Expires{' '}
                    {new Date(pairing.expiresAt).toLocaleTimeString()}.
                  </Typography>
                </Alert>
              ) : (
                <Button variant="outlined" size="small" onClick={async () => setPairing(await api.pairStart())}>
                  Generate pairing code
                </Button>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent>
              <SectionHeader
                title="Awaiting approval"
                subtitle="Discovered operations never run until a human approves them."
                action={
                  <Button size="small" onClick={() => onNavigate('tools')}>
                    Review
                  </Button>
                }
              />
              {drafts.length === 0 ? (
                <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
                  Nothing pending. Enable a site and start discovery to find APIs.
                </Typography>
              ) : (
                <Stack spacing={1}>
                  {drafts.slice(0, 5).map((tool) => (
                    <Stack
                      key={tool.id}
                      direction="row"
                      spacing={1}
                      alignItems="center"
                      onClick={() => onSelectTool(tool.id)}
                      sx={{ cursor: 'pointer', '&:hover': { opacity: 0.8 } }}
                    >
                      <MethodChip method={tool.method} />
                      <Typography sx={{ fontSize: 12, fontFamily: 'ui-monospace, Menlo, monospace', flex: 1, minWidth: 0 }} noWrap>
                        {tool.fqName}
                      </Typography>
                      <PermissionChip permission={tool.permission} />
                    </Stack>
                  ))}
                </Stack>
              )}
            </CardContent>
          </Card>
        </Stack>
      </Box>
    </Box>
  );
}
