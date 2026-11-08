import type { Theme } from '@mui/material/styles';
import { createTheme } from '@mui/material/styles';

export const theme: Theme = createTheme({
  palette: {
    mode: 'dark',
    primary: { main: '#3b82f6', light: '#60a5fa', dark: '#2563eb' },
    secondary: { main: '#8b5cf6' },
    success: { main: '#22c55e' },
    warning: { main: '#f59e0b' },
    error: { main: '#ef4444' },
    background: { default: '#080d19', paper: '#111827' },
    divider: 'rgba(148,163,184,0.14)',
    text: { primary: '#e6edf7', secondary: '#93a4c0' },
  },
  shape: { borderRadius: 12 },
  typography: {
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    h4: { fontWeight: 700, letterSpacing: '-0.02em' },
    h5: { fontWeight: 650, letterSpacing: '-0.01em' },
    h6: { fontWeight: 650 },
    button: { textTransform: 'none', fontWeight: 600 },
    caption: { letterSpacing: '0.01em' },
  },
  components: {
    MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
    MuiCard: {
      styleOverrides: {
        root: {
          border: '1px solid rgba(148,163,184,0.14)',
          background: 'linear-gradient(180deg, rgba(17,24,39,0.9), rgba(12,18,32,0.9))',
        },
      },
    },
    MuiTableCell: { styleOverrides: { root: { borderBottom: '1px solid rgba(148,163,184,0.1)' } } },
    MuiChip: { styleOverrides: { root: { fontWeight: 600 } } },
    MuiTooltip: { defaultProps: { placement: 'top' } },
  },
});
