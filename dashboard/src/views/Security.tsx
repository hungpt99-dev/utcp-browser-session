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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import type { Api, RuntimeStatus } from '../api.ts';
import type { AuditEvent, ToolRecord } from '@utcp-browser-session/shared';
import { EmptyState, SectionHeader, StatCard, StatusChip } from '../components.tsx';

const SEVERITY_COLOR: Record<string, string> = { info: '#60a5fa', warn: '#f59e0b', error: '#ef4444' };

export default function Security({ api, status, onChanged }: { api: Api; status: RuntimeStatus; onChanged: () => void }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [revoked, setRevoked] = useState<ToolRecord[]>([]);
  const [clients, setClients] = useState<Array<{ clientId: string; label: string; extensionId: string; createdAt: string; lastSeenAt: string | null; revoked: boolean }>>([]);
  const [filter, setFilter] = useState<'all' | 'warn' | 'error'>('all');
  const [chain, setChain] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [audit, tools, paired] = await Promise.all([api.audit(200), api.tools('revoked'), api.clients()]);
    setEvents(audit.events);
    setRevoked(tools.tools);
    setClients(paired.clients);
  }, [api]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  const visible = filter === 'all' ? events : events.filter((event) => event.severity === filter);
  const rejected = events.filter((event) => event.kind === 'tool.rejected').length;
  const blocked = events.filter((event) => event.kind === 'request.redirect_blocked' || event.kind === 'extension.handshake_rejected').length;

  return (
    <Box>
      <SectionHeader title="Security center" subtitle="Domains, approvals, revocations and the audit trail." />

      {chain && (
        <Alert severity={chain.startsWith('Chain intact') ? 'success' : 'warning'} sx={{ mb: 2 }} onClose={() => setChain(null)}>
          {chain} Each event is hashed with the previous one, so an edited or removed entry breaks the chain.
        </Alert>
      )}

      <Stack direction="row" spacing={2} sx={{ mb: 2, flexWrap: 'wrap', rowGap: 2 }}>
        <StatCard label="Enabled domains" value={status.stats.enabledDomains} hint="exact hostname match" />
        <StatCard label="Approved tools" value={status.stats.approved} hint="explicit human approval" />
        <StatCard label="Revoked tools" value={status.stats.revoked} hint="cannot execute" accent="#f59e0b" />
        <StatCard label="Rejected calls" value={rejected} hint="blocked by policy" accent="#ef4444" />
        <StatCard label="Blocked handshakes / redirects" value={blocked} accent="#f59e0b" />
      </Stack>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1.5fr 1fr' }, gap: 2 }}>
        <Card>
          <CardContent>
            <Stack direction="row" alignItems="center" sx={{ mb: 1.5 }}>
              <Typography sx={{ fontWeight: 650, flex: 1 }}>Audit trail</Typography>
              <Button
                size="small"
                variant="outlined"
                sx={{ mr: 1 }}
                onClick={async () => {
                  try {
                    const report = await api.verifyAudit();
                    setChain(
                      report.ok
                        ? `Chain intact across ${report.checked} event(s).`
                        : `Chain broken at ${report.brokenAt ?? 'unknown'}.`,
                    );
                  } catch (cause) {
                    setChain(cause instanceof Error ? cause.message : 'Verification failed.');
                  }
                }}
              >
                Verify chain
              </Button>
              <Stack direction="row" spacing={0.5}>
                {(['all', 'warn', 'error'] as const).map((value) => (
                  <Chip
                    key={value}
                    size="small"
                    label={value}
                    onClick={() => setFilter(value)}
                    color={filter === value ? 'primary' : 'default'}
                    variant={filter === value ? 'filled' : 'outlined'}
                    sx={{ height: 22, fontSize: 10.5 }}
                  />
                ))}
              </Stack>
            </Stack>
            {visible.length === 0 ? (
              <EmptyState title="No events" body="Approvals, executions, rejections and pairing attempts land here." />
            ) : (
              <Box sx={{ maxHeight: 520, overflow: 'auto' }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Time</TableCell>
                      <TableCell>Event</TableCell>
                      <TableCell>Message</TableCell>
                      <TableCell>Severity</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {visible.map((event) => (
                      <TableRow key={event.id} hover>
                        <TableCell sx={{ fontSize: 11, color: 'text.secondary', whiteSpace: 'nowrap' }}>
                          {new Date(event.at).toLocaleTimeString()}
                        </TableCell>
                        <TableCell sx={{ fontSize: 11.5, fontFamily: 'ui-monospace, Menlo, monospace' }}>{event.kind}</TableCell>
                        <TableCell sx={{ fontSize: 11.5 }}>{event.message}</TableCell>
                        <TableCell>
                          <Chip
                            size="small"
                            label={event.severity}
                            sx={{
                              height: 19,
                              fontSize: 9.5,
                              color: SEVERITY_COLOR[event.severity],
                              backgroundColor: `${SEVERITY_COLOR[event.severity]}1a`,
                            }}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Box>
            )}
          </CardContent>
        </Card>

        <Stack spacing={2}>
          <Card>
            <CardContent>
              <Typography sx={{ fontWeight: 650, mb: 1 }}>Paired browsers</Typography>
              {clients.length === 0 ? (
                <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>No extension has paired yet.</Typography>
              ) : (
                <Stack spacing={1.25} divider={<Divider />}>
                  {clients.map((client) => (
                    <Box key={client.clientId}>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Typography sx={{ fontSize: 12.5, fontWeight: 600, flex: 1 }}>{client.label}</Typography>
                        <Chip
                          size="small"
                          label={client.revoked ? 'revoked' : 'active'}
                          color={client.revoked ? 'error' : 'success'}
                          variant="outlined"
                          sx={{ height: 19, fontSize: 10 }}
                        />
                      </Stack>
                      <Typography sx={{ fontSize: 11, color: 'text.secondary', fontFamily: 'ui-monospace, Menlo, monospace' }}>
                        {client.clientId}
                      </Typography>
                      <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
                        ext {client.extensionId.slice(0, 12)}… · last seen{' '}
                        {client.lastSeenAt ? new Date(client.lastSeenAt).toLocaleTimeString() : 'never'}
                      </Typography>
                      {!client.revoked && (
                        <Button
                          size="small"
                          color="error"
                          variant="text"
                          sx={{ mt: 0.5, px: 0 }}
                          onClick={async () => {
                            await api.revokeClient(client.clientId);
                            await load();
                            onChanged();
                          }}
                        >
                          Revoke pairing
                        </Button>
                      )}
                    </Box>
                  ))}
                </Stack>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent>
              <Typography sx={{ fontWeight: 650, mb: 1 }}>Revoked tools</Typography>
              {revoked.length === 0 ? (
                <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>Nothing revoked.</Typography>
              ) : (
                <Stack spacing={0.75}>
                  {revoked.slice(0, 8).map((tool) => (
                    <Stack key={tool.id} direction="row" spacing={1} alignItems="center">
                      <Typography sx={{ fontSize: 11.5, fontFamily: 'ui-monospace, Menlo, monospace', flex: 1 }} noWrap>
                        {tool.fqName}
                      </Typography>
                      <StatusChip status={tool.status} />
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
