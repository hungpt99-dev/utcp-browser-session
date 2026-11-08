import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Link,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';

interface Status {
  paired: boolean;
  connected: boolean;
  runtimeUrl: string;
  clientId: string | null;
  label: string;
  lastError: string | null;
  enabledOrigins: string[];
  capturing: string[];
  deepCaptureOrigins: string[];
  enumCaptureOrigins: string[];
}

const DEFAULT_RUNTIME = 'http://127.0.0.1:8777';

async function send<T = unknown>(message: Record<string, unknown>): Promise<T> {
  return (await chrome.runtime.sendMessage(message)) as T;
}

function activeOrigin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/** `https://app.example.com:8443` -> `app.example.com` */
function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [tabUrl, setTabUrl] = useState<string | undefined>();
  const [runtimeUrl, setRuntimeUrl] = useState(DEFAULT_RUNTIME);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const next = await send<Status>({ type: 'ubs:status' });
    setStatus(next);
    setRuntimeUrl((current) => (next?.runtimeUrl && current === DEFAULT_RUNTIME ? next.runtimeUrl : current));
  }, []);

  useEffect(() => {
    void refresh();
    void chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(([tab]) => setTabUrl(tab?.url))
      .catch(() => undefined);
    const listener = () => void refresh();
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [refresh]);

  const origin = activeOrigin(tabUrl);

  const pair = async () => {
    setBusy(true);
    setError(null);
    const result = await send<{ ok: boolean; error?: string }>({ type: 'ubs:pair', runtimeUrl, code });
    setBusy(false);
    if (!result?.ok) setError(result?.error ?? 'Pairing failed.');
    else {
      setCode('');
      setNotice('Paired. The runtime now shows this browser as connected.');
      await refresh();
    }
  };

  const enableCurrentSite = async () => {
    if (!origin) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
      if (!granted) {
        setError(`Chrome did not grant access to ${hostOf(origin)}.`);
        return;
      }
      const result = await send<{ ok: boolean }>({ type: 'ubs:intent', action: 'enable_origin', origin });
      if (!result?.ok) setError('The runtime is not connected, so the site could not be enabled.');
      else setNotice(`${hostOf(origin)} enabled. Start discovery to record its API.`);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const toggleDiscovery = async (target: string, on: boolean) => {
    const result = await send<{ ok: boolean; error?: string }>({
      type: 'ubs:intent',
      action: on ? 'discovery_start' : 'discovery_stop',
      origin: target,
    });
    if (on && result && result.ok === false) setError(result.error ?? 'Discovery could not start.');
    await refresh();
  };

  if (!status) {
    return (
      <Box sx={{ p: 4, display: 'grid', placeItems: 'center' }}>
        <CircularProgress size={22} />
      </Box>
    );
  }

  return (
    <Box sx={{ pb: 1.5 }}>
      <Box
        sx={{
          px: 2,
          py: 1.5,
          background: 'linear-gradient(120deg, rgba(59,130,246,.22), rgba(139,92,246,.18))',
          borderBottom: '1px solid',
          borderColor: 'divider',
        }}
      >
        <Stack direction="row" spacing={1} alignItems="center">
          <Box
            component="img"
            src="../icons/icon48.png"
            alt=""
            sx={{ width: 26, height: 26, borderRadius: '7px' }}
          />
          <Box sx={{ flex: 1 }}>
            <Typography sx={{ fontWeight: 700, fontSize: 13.5, lineHeight: 1.2 }}>UTCP Browser Session</Typography>
            <Typography variant="caption" color="text.secondary">
              Bridge your session, not your cookies
            </Typography>
          </Box>
          <Chip
            size="small"
            label={status.connected ? 'Connected' : status.paired ? 'Offline' : 'Not paired'}
            color={status.connected ? 'success' : status.paired ? 'warning' : 'default'}
            variant={status.connected ? 'filled' : 'outlined'}
          />
        </Stack>
      </Box>

      <Stack spacing={1.5} sx={{ px: 2, pt: 1.5 }}>
        {error && (
          <Alert severity="error" onClose={() => setError(null)} sx={{ py: 0, fontSize: 12 }}>
            {error}
          </Alert>
        )}
        {notice && (
          <Alert severity="success" onClose={() => setNotice(null)} sx={{ py: 0, fontSize: 12 }}>
            {notice}
          </Alert>
        )}
        {!error && status.lastError && !status.connected && (
          <Alert severity="warning" sx={{ py: 0, fontSize: 12 }}>
            {status.lastError}
          </Alert>
        )}

        {!status.paired ? (
          <Box>
            <Typography sx={{ fontSize: 12, color: 'text.secondary', mb: 1 }}>
              Run <code>utcp-browser-session pair</code>, then paste the code below.
            </Typography>
            <TextField
              fullWidth
              size="small"
              label="Runtime address"
              value={runtimeUrl}
              onChange={(event) => setRuntimeUrl(event.target.value)}
              sx={{ mb: 1 }}
            />
            <TextField
              fullWidth
              size="small"
              label="Pairing code"
              placeholder="ABCD-2345"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && code.length >= 4) void pair();
              }}
            />
            <Button fullWidth variant="contained" sx={{ mt: 1.25 }} disabled={busy || code.length < 4} onClick={() => void pair()}>
              {busy ? 'Pairing…' : 'Pair browser'}
            </Button>
          </Box>
        ) : (
          <>
            <Box>
              <MessageRow label="Runtime" value={status.runtimeUrl} />
              <MessageRow label="Client" value={status.clientId ?? '—'} mono />
              <MessageRow label="Domains" value={`${status.enabledOrigins.length} enabled`} />
            </Box>

            <Divider />

            <Box>
              <Typography sx={{ fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: 'text.secondary', mb: 0.75 }}>
                This tab
              </Typography>
              {origin ? (
                <Stack direction="row" spacing={1} alignItems="center">
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography sx={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {hostOf(origin)}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {status.enabledOrigins.includes(origin) ? 'Approved for tools' : 'Not approved yet'}
                    </Typography>
                  </Box>
                  {status.enabledOrigins.includes(origin) ? (
                    <Tooltip title="Record this site's API while you use it">
                      <Switch
                        size="small"
                        checked={status.capturing.includes(origin)}
                        onChange={(event) => void toggleDiscovery(origin, event.target.checked)}
                      />
                    </Tooltip>
                  ) : (
                    <Button size="small" variant="outlined" disabled={busy} onClick={() => void enableCurrentSite()}>
                      Enable
                    </Button>
                  )}
                </Stack>
              ) : (
                <Typography variant="caption" color="text.secondary">
                  Open a website tab to enable it.
                </Typography>
              )}
            </Box>

            {status.enabledOrigins.length > 0 && (
              <>
                <Divider />
                <Box>
                  <Typography sx={{ fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: 'text.secondary', mb: 0.75 }}>
                    Approved domains
                  </Typography>
                  <Stack spacing={0.5}>
                    {status.enabledOrigins.map((item) => (
                      <Stack key={item} direction="row" spacing={1} alignItems="center">
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Typography sx={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis' }}>{hostOf(item)}</Typography>
                          <Typography variant="caption" color="text.secondary">
                            {status.capturing.includes(item) ? 'Capturing API traffic' : 'Idle'}
                            {status.deepCaptureOrigins.includes(item) ? ' · schema capture on' : ''}
                          </Typography>
                        </Box>
                        <Switch
                          size="small"
                          checked={status.capturing.includes(item)}
                          onChange={(event) => void toggleDiscovery(item, event.target.checked)}
                        />
                      </Stack>
                    ))}
                  </Stack>
                </Box>
              </>
            )}

            <Divider />
            <Stack direction="row" spacing={1}>
              <Button size="small" variant="outlined" onClick={() => void send({ type: 'ubs:reconnect' })}>
                Reconnect
              </Button>
              <Button
                size="small"
                variant="text"
                color="inherit"
                onClick={async () => {
                  await send({ type: 'ubs:unpair' });
                  await refresh();
                }}
              >
                Unpair
              </Button>
              <Box sx={{ flex: 1 }} />
              <Link
                href={`${status.runtimeUrl}/`}
                target="_blank"
                rel="noreferrer"
                sx={{ fontSize: 12, alignSelf: 'center' }}
              >
                Dashboard
              </Link>
            </Stack>
          </>
        )}
      </Stack>
    </Box>
  );
}

function MessageRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <Stack direction="row" spacing={1} sx={{ py: 0.25 }}>
      <Typography sx={{ fontSize: 12, color: 'text.secondary', width: 62, flexShrink: 0 }}>{label}</Typography>
      <Typography
        sx={{
          fontSize: 12,
          fontFamily: mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </Typography>
    </Stack>
  );
}
