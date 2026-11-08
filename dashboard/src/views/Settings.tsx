import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Divider,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopyOutlined';
import type { Api, RuntimeStatus } from '../api.ts';
import { JsonBlock, KeyValue, SectionHeader } from '../components.tsx';

export default function Settings({
  api,
  status,
  onChanged,
}: {
  api: Api;
  status: RuntimeStatus;
  onChanged: () => void;
}) {
  const [form, setForm] = useState({
    manualName: status.settings.manualName,
    defaultTimeoutMs: status.settings.defaultTimeoutMs,
    maxResponseBytes: status.settings.maxResponseBytes,
    rateLimitPerMinute: status.settings.rateLimitPerMinute,
    maxInFlight: status.settings.maxInFlight,
    maxQueue: status.settings.maxQueue,
  });
  const [manual, setManual] = useState<unknown>(null);
  const [report, setReport] = useState<{ ok: boolean; errors: string[]; warnings: string[]; toolCount: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setForm({
      manualName: status.settings.manualName,
      defaultTimeoutMs: status.settings.defaultTimeoutMs,
      maxResponseBytes: status.settings.maxResponseBytes,
      rateLimitPerMinute: status.settings.rateLimitPerMinute,
      maxInFlight: status.settings.maxInFlight,
      maxQueue: status.settings.maxQueue,
    });
  }, [status.settings]);

  const save = async () => {
    try {
      await api.settings(form);
      setNotice('Settings saved.');
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save settings.');
    }
  };

  return (
    <Box>
      <SectionHeader title="Settings" subtitle="Runtime limits, the generated manual, and where the token lives." />

      {notice && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice(null)}>{notice}</Alert>}
      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, gap: 2 }}>
        <Card>
          <CardContent>
            <Typography sx={{ fontWeight: 650, mb: 1.5 }}>Limits</Typography>
            <Stack spacing={1.5}>
              <TextField
                size="small"
                label="Manual name"
                value={form.manualName}
                onChange={(event) => setForm({ ...form, manualName: event.target.value })}
                helperText="Tools are namespaced as <manual>.<tool>"
              />
              <TextField
                size="small"
                type="number"
                label="Default timeout (ms)"
                value={form.defaultTimeoutMs}
                onChange={(event) => setForm({ ...form, defaultTimeoutMs: Number(event.target.value) })}
              />
              <TextField
                size="small"
                type="number"
                label="Max response bytes"
                value={form.maxResponseBytes}
                onChange={(event) => setForm({ ...form, maxResponseBytes: Number(event.target.value) })}
                helperText="Larger responses are truncated and flagged."
              />
              <TextField
                size="small"
                type="number"
                label="Rate limit (calls / minute / tool)"
                value={form.rateLimitPerMinute}
                onChange={(event) => setForm({ ...form, rateLimitPerMinute: Number(event.target.value) })}
              />
              <TextField
                size="small"
                type="number"
                label="Max calls in flight"
                value={form.maxInFlight}
                onChange={(event) => setForm({ ...form, maxInFlight: Number(event.target.value) })}
                helperText="Extra calls queue instead of hitting the browser at once."
              />
              <TextField
                size="small"
                type="number"
                label="Max queued calls"
                value={form.maxQueue}
                onChange={(event) => setForm({ ...form, maxQueue: Number(event.target.value) })}
                helperText="Beyond this the runtime answers busy rather than buffering."
              />
              <Box>
                <Button variant="contained" onClick={() => void save()}>
                  Save settings
                </Button>
              </Box>
            </Stack>
          </CardContent>
        </Card>

        <Card>
          <CardContent>
            <Typography sx={{ fontWeight: 650, mb: 1.5 }}>UTCP integration</Typography>
            <Stack spacing={0.25}>
              <KeyValue label="Transport">
                <code>utcp_browser_session</code>
              </KeyValue>
              <KeyValue label="Runtime URL">{status.connection.connected ? window.location.origin : window.location.origin}</KeyValue>
              <KeyValue label="Token variable">
                <code>{status.tokenVariable}</code>
              </KeyValue>
              <KeyValue label="Manual endpoint">
                <code>/api/v1/manual</code>
              </KeyValue>
              <KeyValue label="Runtime id">{status.runtimeId}</KeyValue>
            </Stack>

            <Divider sx={{ my: 1.5 }} />
            <Stack direction="row" spacing={1}>
              <Button
                size="small"
                variant="outlined"
                onClick={async () => {
                  const value = await api.manual();
                  setManual(value);
                  setReport(await api.validateManual());
                }}
              >
                Generate &amp; validate manual
              </Button>
              <Button
                size="small"
                startIcon={<ContentCopyIcon fontSize="small" />}
                disabled={!manual}
                onClick={() => void navigator.clipboard?.writeText(JSON.stringify(manual, null, 2))}
              >
                Copy JSON
              </Button>
            </Stack>

            {report && (
              <Alert severity={report.ok ? 'success' : 'error'} sx={{ mt: 1.5 }}>
                {report.ok
                  ? `Manual is valid — ${report.toolCount} tool(s), ${report.warnings.length} warning(s).`
                  : report.errors.join(' ')}
              </Alert>
            )}
            {manual != null && (
              <Box sx={{ mt: 1.5 }}>
                <JsonBlock value={manual} maxHeight={240} />
              </Box>
            )}
          </CardContent>
        </Card>
      </Box>

      <Card sx={{ mt: 2 }}>
        <CardContent>
          <Typography sx={{ fontWeight: 650, mb: 1 }}>Security boundaries</Typography>
          <Typography sx={{ fontSize: 12.5, color: 'text.secondary', lineHeight: 1.7 }}>
            The runtime never receives cookies, authorization headers or CSRF tokens. Execution happens in the
            extension's service worker, where Chrome attaches the site's own cookies at the network layer. The runtime
            token lives in <code>~/.utcp-browser-session/runtime-token</code> with mode 0600; pairing keys are ECDSA
            P-256 and only the public half is stored here. See <code>docs/security.md</code> for the full threat model.
          </Typography>
        </CardContent>
      </Card>
    </Box>
  );
}
