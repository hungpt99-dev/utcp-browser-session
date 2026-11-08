import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  CssBaseline,
  Divider,
  Drawer,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  TextField,
  ThemeProvider,
  Tooltip,
  Typography,
} from '@mui/material';
import DashboardIcon from '@mui/icons-material/SpaceDashboardOutlined';
import LanguageIcon from '@mui/icons-material/LanguageOutlined';
import HandymanIcon from '@mui/icons-material/HandymanOutlined';
import PlayIcon from '@mui/icons-material/PlayCircleOutline';
import ShieldIcon from '@mui/icons-material/ShieldOutlined';
import SettingsIcon from '@mui/icons-material/TuneOutlined';
import { Api, ApiError, type RuntimeStatus } from './api.ts';
import { theme } from './theme.ts';
import Overview from './views/Overview.tsx';
import Websites from './views/Websites.tsx';
import Tools from './views/Tools.tsx';
import Executions from './views/Executions.tsx';
import Security from './views/Security.tsx';
import Settings from './views/Settings.tsx';

const NAV = [
  { id: 'overview', label: 'Overview', icon: <DashboardIcon fontSize="small" /> },
  { id: 'websites', label: 'Websites', icon: <LanguageIcon fontSize="small" /> },
  { id: 'tools', label: 'Tools', icon: <HandymanIcon fontSize="small" /> },
  { id: 'executions', label: 'Executions', icon: <PlayIcon fontSize="small" /> },
  { id: 'security', label: 'Security', icon: <ShieldIcon fontSize="small" /> },
  { id: 'settings', label: 'Settings', icon: <SettingsIcon fontSize="small" /> },
] as const;

type ViewId = (typeof NAV)[number]['id'];

function readBootstrapToken(): string {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get('token');
  if (fromUrl) {
    window.localStorage.setItem('ubs.token', fromUrl);
    params.delete('token');
    const query = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
    return fromUrl;
  }
  return window.localStorage.getItem('ubs.token') ?? '';
}

export default function App() {
  const [token, setToken] = useState(readBootstrapToken);
  const [draftToken, setDraftToken] = useState('');
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewId>('overview');
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const api = useMemo(() => (token ? new Api(window.location.origin, token) : null), [token]);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      const next = await api.status();
      setStatus(next);
      setError(null);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        setError('The runtime rejected this token. Copy the token printed by `utcp-browser-session serve`.');
      } else {
        setError(cause instanceof Error ? cause.message : 'The runtime is unreachable.');
      }
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [refresh, refreshKey]);

  const bump = () => setRefreshKey((value) => value + 1);

  if (!token) {
    return (
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', px: 2 }}>
          <Box sx={{ width: 460, maxWidth: '100%' }}>
            <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 3 }}>
              <Box component="img" src="./icon.svg" alt="" sx={{ width: 42, height: 42 }} />
              <Box>
                <Typography variant="h5">UTCP Browser Session</Typography>
                <Typography sx={{ color: 'text.secondary', fontSize: 13 }}>Local runtime dashboard</Typography>
              </Box>
            </Stack>
            <Typography sx={{ fontSize: 13, color: 'text.secondary', mb: 2 }}>
              Paste the runtime token. It is printed when you start the runtime and stored in{' '}
              <code>~/.utcp-browser-session/runtime-token</code>.
            </Typography>
            <TextField
              fullWidth
              size="small"
              label="Runtime token"
              value={draftToken}
              onChange={(event) => setDraftToken(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && draftToken.length > 8) {
                  window.localStorage.setItem('ubs.token', draftToken.trim());
                  setToken(draftToken.trim());
                }
              }}
            />
            <Button
              fullWidth
              variant="contained"
              sx={{ mt: 1.5 }}
              disabled={draftToken.length < 8}
              onClick={() => {
                window.localStorage.setItem('ubs.token', draftToken.trim());
                setToken(draftToken.trim());
              }}
            >
              Open dashboard
            </Button>
          </Box>
        </Box>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ display: 'flex', minHeight: '100vh' }}>
        <Drawer
          variant="permanent"
          sx={{
            width: 218,
            flexShrink: 0,
            '& .MuiDrawer-paper': {
              width: 218,
              boxSizing: 'border-box',
              borderRight: '1px solid',
              borderColor: 'divider',
              backgroundColor: '#0a1020',
            },
          }}
        >
          <Stack direction="row" spacing={1.25} alignItems="center" sx={{ px: 2, py: 2 }}>
            <Box component="img" src="./icon.svg" alt="" sx={{ width: 30, height: 30 }} />
            <Box sx={{ minWidth: 0 }}>
              <Typography sx={{ fontWeight: 700, fontSize: 13, lineHeight: 1.25 }}>UTCP Browser</Typography>
              <Typography sx={{ fontSize: 10.5, color: 'text.secondary' }}>session bridge</Typography>
            </Box>
          </Stack>
          <Divider />
          <List sx={{ px: 1, py: 1.5 }}>
            {NAV.map((item) => (
              <ListItemButton
                key={item.id}
                selected={view === item.id}
                onClick={() => {
                  setView(item.id);
                  if (item.id !== 'tools') setSelectedToolId(null);
                }}
                sx={{
                  borderRadius: 1.5,
                  mb: 0.35,
                  '&.Mui-selected': { backgroundColor: 'rgba(59,130,246,0.16)' },
                }}
              >
                <ListItemIcon sx={{ minWidth: 32, color: view === item.id ? 'primary.light' : 'text.secondary' }}>
                  {item.icon}
                </ListItemIcon>
                <ListItemText primaryTypographyProps={{ fontSize: 13, fontWeight: view === item.id ? 650 : 500 }}>
                  {item.label}
                </ListItemText>
                {item.id === 'tools' && status && status.stats.drafts > 0 && (
                  <Chip size="small" label={status.stats.drafts} sx={{ height: 18, fontSize: 10 }} color="warning" />
                )}
              </ListItemButton>
            ))}
          </List>
          <Box sx={{ flex: 1 }} />
          <Box sx={{ px: 2, py: 1.5, borderTop: '1px solid', borderColor: 'divider' }}>
            <Stack direction="row" spacing={0.75} alignItems="center">
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  backgroundColor: status?.connection.connected ? 'success.main' : 'warning.main',
                }}
              />
              <Typography sx={{ fontSize: 11.5, color: 'text.secondary' }}>
                {status?.connection.connected ? 'Browser connected' : 'Browser offline'}
              </Typography>
            </Stack>
            <Tooltip title={status?.connection.client?.clientId ?? 'no client'}>
              <Typography sx={{ fontSize: 10.5, color: 'text.secondary', mt: 0.5 }} noWrap>
                {status?.connection.client?.label ?? 'pair the extension to start'}
              </Typography>
            </Tooltip>
          </Box>
        </Drawer>

        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <Box
            sx={{
              px: 3,
              py: 1.5,
              borderBottom: '1px solid',
              borderColor: 'divider',
              display: 'flex',
              alignItems: 'center',
              gap: 2,
              backgroundColor: 'rgba(10,16,32,0.6)',
              position: 'sticky',
              top: 0,
              zIndex: 2,
              backdropFilter: 'blur(8px)',
            }}
          >
            <Typography sx={{ fontSize: 13, fontWeight: 650, textTransform: 'capitalize' }}>{view}</Typography>
            <Box sx={{ flex: 1 }} />
            {status && (
              <Chip
                size="small"
                variant="outlined"
                label={`${status.stats.approved} approved · ${status.stats.drafts} drafts · ${status.stats.enabledDomains} sites`}
                sx={{ fontSize: 11 }}
              />
            )}
            <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>runtime {status?.version ?? '—'}</Typography>
          </Box>

          <Box sx={{ p: 3, maxWidth: 1180, width: '100%' }}>
            {error && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {error}
              </Alert>
            )}
            {!api ? null : !status ? (
              <Box sx={{ py: 8, display: 'grid', placeItems: 'center' }}>
                <CircularProgress size={26} />
              </Box>
            ) : view === 'overview' ? (
              <Overview api={api} status={status} onNavigate={setView} onSelectTool={(id) => { setSelectedToolId(id); setView('tools'); }} />
            ) : view === 'websites' ? (
              <Websites api={api} status={status} onChanged={bump} />
            ) : view === 'tools' ? (
              <Tools api={api} initialToolId={selectedToolId} onChanged={bump} />
            ) : view === 'executions' ? (
              <Executions api={api} />
            ) : view === 'security' ? (
              <Security api={api} status={status} onChanged={bump} />
            ) : (
              <Settings api={api} status={status} onChanged={bump} />
            )}
          </Box>
        </Box>
      </Box>
    </ThemeProvider>
  );
}
