import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Collapse,
  Divider,
  IconButton,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  MenuItem,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrowOutlined';
import StopIcon from '@mui/icons-material/StopOutlined';
import AddIcon from '@mui/icons-material/AddOutlined';
import ExpandIcon from '@mui/icons-material/ExpandMoreOutlined';
import type { Api, DomainSummary, RuntimeStatus } from '../api.ts';
import type { DiscoveredEndpointRecord } from '@utcp-browser-session/shared';
import { EmptyState, MethodChip, PermissionChip, SectionHeader } from '../components.tsx';

export default function Websites({
  api,
  status,
  onChanged,
}: {
  api: Api;
  status: RuntimeStatus;
  onChanged: () => void;
}) {
  const [domains, setDomains] = useState<DomainSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [deepCapture, setDeepCapture] = useState(true);
  const [csrfPath, setCsrfPath] = useState('');
  const [csrfField, setCsrfField] = useState('token');
  const [csrfHeader, setCsrfHeader] = useState('x-csrf-token');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [endpoints, setEndpoints] = useState<Record<string, DiscoveredEndpointRecord[]>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await api.domains();
    setDomains(result.domains);
    if (expanded) {
      const list = await api.endpoints(expanded);
      setEndpoints((current) => ({ ...current, [expanded]: list.endpoints }));
    }
  }, [api, expanded]);

  useEffect(() => {
    void load().catch((cause) => setError(cause instanceof Error ? cause.message : 'Failed to load domains.'));
  }, [load]);

  useEffect(() => {
    if (!expanded) return;
    const timer = setInterval(() => {
      void api.endpoints(expanded).then((list) => setEndpoints((current) => ({ ...current, [expanded]: list.endpoints })));
    }, 2500);
    return () => clearInterval(timer);
  }, [api, expanded]);

  const addDomain = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.addDomain({
        domain: input.trim(),
        deepCapture,
        ...(csrfPath.trim()
          ? { csrf: { bootstrapPath: csrfPath.trim(), tokenField: csrfField.trim(), header: csrfHeader.trim() } }
          : {}),
      });
      setInput('');
      setCsrfPath('');
      setNotice('Domain enabled. Start discovery, use the site in Chrome, then generate drafts.');
      await load();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not enable the domain.');
    } finally {
      setBusy(false);
    }
  };

  const toggleDiscovery = async (domain: string, start: boolean) => {
    try {
      if (start) await api.startDiscovery(domain);
      else await api.stopDiscovery(domain);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Discovery control failed.');
    }
  };

  const applyPolicy = async (
    origin: string,
    policy: { maxPermission?: 'READ' | 'WRITE' | 'DESTRUCTIVE'; confirmWrites?: boolean },
  ) => {
    try {
      await api.patchDomain(origin, { policy });
      await load();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update the policy.');
    }
  };

  const generate = async (domain: string) => {
    try {
      const result = await api.generate(domain);
      setNotice(
        result.created.length
          ? `${result.created.length} draft tool(s) created for ${domain}. Review them under Tools.`
          : `No new drafts: ${result.skipped[0] ?? 'nothing to generate'}`,
      );
      await load();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Draft generation failed.');
    }
  };

  return (
    <Box>
      <SectionHeader
        title="Websites"
        subtitle="Exact-domain allowlist. Tools can only call the origin they were discovered on."
      />

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {notice && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      )}
      {!status.connection.connected && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          No browser is connected. Pair the extension first — discovery and execution both need it.
        </Alert>
      )}

      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Typography sx={{ fontWeight: 650, mb: 1.25 }}>Enable a website</Typography>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.25} alignItems={{ md: 'center' }}>
            <TextField
              size="small"
              label="Site URL or hostname"
              placeholder="https://app.example.com or 127.0.0.1:8788"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              sx={{ flex: 1.4 }}
            />
            <TextField
              size="small"
              label="CSRF bootstrap path (optional)"
              placeholder="/api/csrf"
              value={csrfPath}
              onChange={(event) => setCsrfPath(event.target.value)}
              sx={{ flex: 1 }}
            />
            <TextField
              size="small"
              label="JSON field"
              value={csrfField}
              onChange={(event) => setCsrfField(event.target.value)}
              sx={{ width: 110 }}
            />
            <TextField
              size="small"
              label="Header"
              value={csrfHeader}
              onChange={(event) => setCsrfHeader(event.target.value)}
              sx={{ width: 140 }}
            />
            <Stack direction="row" spacing={1} alignItems="center">
              <Tooltip title="Capture JSON request/response shapes with the page tap (structure only, no values)">
                <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>Schema capture</Typography>
              </Tooltip>
              <Switch size="small" checked={deepCapture} onChange={(event) => setDeepCapture(event.target.checked)} />
            </Stack>
            <Button variant="contained" startIcon={<AddIcon />} disabled={busy || input.trim().length < 3} onClick={() => void addDomain()}>
              Enable
            </Button>
          </Stack>
          <Typography sx={{ fontSize: 11.5, color: 'text.secondary', mt: 1 }}>
            CSRF is opt-in: if the site needs a token, point the bootstrap path at a JSON endpoint that returns it. Nothing else is guessed.
          </Typography>
        </CardContent>
      </Card>

      {domains.length === 0 ? (
        <Card>
          <EmptyState
            title="No websites enabled"
            body="Enable the local fixture (http://127.0.0.1:8788) to try the full flow, or any site you are signed in to."
          />
        </Card>
      ) : (
        <Stack spacing={1.5}>
          {domains.map((domain) => {
            const capturing = status.connection.capturing.includes(domain.origin);
            const isOpen = expanded === domain.origin;
            const list = endpoints[domain.origin] ?? [];
            return (
              <Card key={domain.origin}>
                <CardContent>
                  <Stack direction="row" spacing={1.5} alignItems="center">
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Typography sx={{ fontWeight: 650 }}>{domain.domain}</Typography>
                        <Chip size="small" label={domain.enabled ? 'enabled' : 'disabled'} color={domain.enabled ? 'success' : 'default'} variant={domain.enabled ? 'filled' : 'outlined'} sx={{ height: 19, fontSize: 10 }} />
                        {domain.deepCapture && <Chip size="small" label="schema capture" sx={{ height: 19, fontSize: 10 }} variant="outlined" />}
                        {domain.captureEnums && <Chip size="small" label="enum sampling" sx={{ height: 19, fontSize: 10 }} variant="outlined" />}
                        {domain.csrf && <Chip size="small" label="csrf bootstrap" sx={{ height: 19, fontSize: 10 }} variant="outlined" />}
                        {domain.session.status === 'expired' && (
                          <Chip size="small" color="warning" label="session expired" sx={{ height: 19, fontSize: 10 }} />
                        )}
                        {domain.policy.maxPermission !== 'DESTRUCTIVE' && (
                          <Chip size="small" color="info" label={`max ${domain.policy.maxPermission.toLowerCase()}`} sx={{ height: 19, fontSize: 10 }} variant="outlined" />
                        )}
                      </Stack>
                      <Typography sx={{ fontSize: 11.5, color: 'text.secondary', mt: 0.25 }}>
                        {domain.domain} · {domain.endpoints} endpoints · {domain.approvedTools} approved tools
                        {domain.session.lastCheckedAt ? ` · last answer ${domain.session.lastStatus ?? '—'}` : ''}
                        {domain.requestCount > 0 ? ` · ${domain.requestCount} calls` : ''}
                      </Typography>
                    </Box>
                    {capturing ? (
                      <Button size="small" color="warning" startIcon={<StopIcon />} onClick={() => void toggleDiscovery(domain.origin, false)}>
                        Stop discovery
                      </Button>
                    ) : (
                      <Button size="small" startIcon={<PlayArrowIcon />} disabled={!status.connection.connected} onClick={() => void toggleDiscovery(domain.origin, true)}>
                        Start discovery
                      </Button>
                    )}
                    <Button size="small" disabled={domain.endpoints === 0} onClick={() => void generate(domain.origin)}>
                      Generate drafts
                    </Button>
                    <Button
                      size="small"
                      color="error"
                      variant="text"
                      onClick={async () => {
                        await api.removeDomain(domain.origin);
                        await load();
                        onChanged();
                      }}
                    >
                      Disable
                    </Button>
                    <IconButton size="small" aria-label={isOpen ? 'Hide endpoints' : 'Show endpoints'} onClick={() => setExpanded(isOpen ? null : domain.origin)}>
                      <ExpandIcon fontSize="small" sx={{ transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
                    </IconButton>
                  </Stack>

                  <Collapse in={isOpen} unmountOnExit>
                    <Divider sx={{ my: 1.5 }} />
                    <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 1.5, flexWrap: 'wrap' }}>
                      <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>Ceiling</Typography>
                      <TextField
                        select
                        size="small"
                        value={domain.policy.maxPermission}
                        onChange={(event) => void applyPolicy(domain.origin, { maxPermission: event.target.value as 'READ' | 'WRITE' | 'DESTRUCTIVE' })}
                        sx={{ width: 150 }}
                      >
                        <MenuItem value="READ">READ only</MenuItem>
                        <MenuItem value="WRITE">up to WRITE</MenuItem>
                        <MenuItem value="DESTRUCTIVE">everything</MenuItem>
                      </TextField>
                      <Tooltip title="Require __confirm on every write, not only destructive calls">
                        <Stack direction="row" spacing={0.5} alignItems="center">
                          <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>Confirm writes</Typography>
                          <Switch
                            size="small"
                            checked={domain.policy.confirmWrites}
                            onChange={(event) => void applyPolicy(domain.origin, { confirmWrites: event.target.checked })}
                          />
                        </Stack>
                      </Tooltip>
                      <Tooltip title="Sample short enum-like values (status/type/priority) so draft tools can list valid values">
                        <Stack direction="row" spacing={0.5} alignItems="center">
                          <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>Enum sampling</Typography>
                          <Switch
                            size="small"
                            checked={domain.captureEnums}
                            onChange={(event) => void api.patchDomain(domain.origin, { captureEnums: event.target.checked }).then(load)}
                          />
                        </Stack>
                      </Tooltip>
                    </Stack>
                    {list.length === 0 ? (
                      <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
                        No endpoints recorded yet. Start discovery, then click around the site in Chrome.
                      </Typography>
                    ) : (
                      <Table size="small">
                        <TableHead>
                          <TableRow>
                            <TableCell>Method</TableCell>
                            <TableCell>Path</TableCell>
                            <TableCell>Permission</TableCell>
                            <TableCell align="right">Samples</TableCell>
                            <TableCell>Kind</TableCell>
                            <TableCell align="right">Confidence</TableCell>
                            <TableCell>Sources</TableCell>
                            <TableCell>Schema</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {list.map((endpoint) => (
                            <TableRow key={endpoint.key} hover>
                              <TableCell><MethodChip method={endpoint.method} /></TableCell>
                              <TableCell sx={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11.5 }}>{endpoint.pathTemplate}</TableCell>
                              <TableCell><PermissionChip permission={endpoint.permission} /></TableCell>
                              <TableCell align="right" sx={{ fontSize: 12 }}>{endpoint.sampleCount}</TableCell>
                              <TableCell sx={{ fontSize: 11, color: 'text.secondary' }}>
                                {endpoint.kind}
                                {endpoint.blocked ? ' (blocked)' : ''}
                                {endpoint.pagination ? ` · ${endpoint.pagination.style}` : ''}
                              </TableCell>
                              <TableCell align="right" sx={{ fontSize: 11, color: endpoint.confidence < 0.45 ? 'warning.main' : 'text.secondary' }}>
                                {Math.round(endpoint.confidence * 100)}%
                              </TableCell>
                              <TableCell sx={{ fontSize: 11, color: 'text.secondary' }}>{endpoint.sources.join(' + ')}</TableCell>
                              <TableCell sx={{ fontSize: 11, color: 'text.secondary' }}>
                                {endpoint.requestSchema ? 'req ' : ''}
                                {endpoint.responseSchema ? 'res' : ''}
                                {!endpoint.requestSchema && !endpoint.responseSchema ? 'shape unknown' : ''}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </Collapse>
                </CardContent>
              </Card>
            );
          })}
        </Stack>
      )}
    </Box>
  );
}
