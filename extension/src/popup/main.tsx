import React from 'react';
import { createRoot } from 'react-dom/client';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import App from './App.tsx';

const theme = createTheme({
  palette: {
    mode: 'dark',
    background: { default: '#0b1020', paper: '#141b2d' },
    primary: { main: '#3b82f6' },
    secondary: { main: '#8b5cf6' },
    success: { main: '#22c55e' },
    warning: { main: '#f59e0b' },
    divider: '#24304a',
  },
  shape: { borderRadius: 10 },
  typography: {
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    fontSize: 13,
  },
  components: {
    MuiButton: { defaultProps: { disableElevation: true }, styleOverrides: { root: { textTransform: 'none', fontWeight: 600 } } },
    MuiChip: { styleOverrides: { root: { height: 22, fontSize: 11 } } },
  },
});

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <App />
    </ThemeProvider>
  </React.StrictMode>,
);
