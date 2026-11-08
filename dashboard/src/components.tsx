import {
  Box,
  Card,
  CardContent,
  Chip,
  Stack,
  Typography,
  type ChipProps,
} from '@mui/material';

const METHOD_COLORS: Record<string, string> = {
  GET: '#22c55e',
  POST: '#3b82f6',
  PUT: '#f59e0b',
  PATCH: '#f59e0b',
  DELETE: '#ef4444',
  HEAD: '#64748b',
  OPTIONS: '#64748b',
};

export function MethodChip({ method }: { method: string }) {
  const color = METHOD_COLORS[method.toUpperCase()] ?? '#64748b';
  return (
    <Chip
      size="small"
      label={method.toUpperCase()}
      sx={{
        height: 20,
        fontSize: 10.5,
        letterSpacing: '0.06em',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        color,
        backgroundColor: `${color}1a`,
        border: `1px solid ${color}40`,
      }}
    />
  );
}

const PERMISSION_STYLE: Record<string, { color: string; label: string }> = {
  READ: { color: '#22c55e', label: 'READ' },
  WRITE: { color: '#f59e0b', label: 'WRITE' },
  DESTRUCTIVE: { color: '#ef4444', label: 'DESTRUCTIVE' },
};

export function PermissionChip({ permission }: { permission: string }) {
  const style = PERMISSION_STYLE[permission] ?? { color: '#64748b', label: permission };
  return (
    <Chip
      size="small"
      label={style.label}
      sx={{ height: 20, fontSize: 10, color: style.color, backgroundColor: `${style.color}1a`, border: `1px solid ${style.color}40` }}
    />
  );
}

export function StatusChip({ status }: { status: string }) {
  const map: Record<string, { color: ChipProps['color']; variant: ChipProps['variant'] }> = {
    draft: { color: 'default', variant: 'outlined' },
    approved: { color: 'success', variant: 'filled' },
    revoked: { color: 'error', variant: 'outlined' },
    ok: { color: 'success', variant: 'filled' },
    rejected: { color: 'warning', variant: 'outlined' },
    error: { color: 'error', variant: 'outlined' },
    timeout: { color: 'warning', variant: 'outlined' },
    disconnected: { color: 'error', variant: 'outlined' },
  };
  const style = map[status] ?? { color: 'default' as const, variant: 'outlined' as const };
  return <Chip size="small" label={status} color={style.color} variant={style.variant} sx={{ height: 20, fontSize: 10.5 }} />;
}

export function StatCard({ label, value, hint, accent }: { label: string; value: string | number; hint?: string; accent?: string }) {
  return (
    <Card sx={{ flex: 1, minWidth: 150 }}>
      <CardContent sx={{ py: 1.75, '&:last-child': { pb: 1.75 } }}>
        <Typography sx={{ fontSize: 11, letterSpacing: '0.09em', textTransform: 'uppercase', color: 'text.secondary' }}>
          {label}
        </Typography>
        <Typography sx={{ fontSize: 26, fontWeight: 700, lineHeight: 1.2, color: accent ?? 'text.primary' }}>{value}</Typography>
        {hint && (
          <Typography sx={{ fontSize: 11.5, color: 'text.secondary' }} noWrap>
            {hint}
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

export function JsonBlock({ value, maxHeight = 260 }: { value: unknown; maxHeight?: number }) {
  return (
    <Box
      component="pre"
      sx={{
        m: 0,
        p: 1.5,
        borderRadius: 1.5,
        border: '1px solid',
        borderColor: 'divider',
        backgroundColor: '#0a1120',
        color: '#9fd0ff',
        fontSize: 11.5,
        lineHeight: 1.55,
        overflow: 'auto',
        maxHeight,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      }}
    >
      {JSON.stringify(value, null, 2)}
    </Box>
  );
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <Box sx={{ py: 5, px: 2, textAlign: 'center' }}>
      <Typography sx={{ fontWeight: 650, mb: 0.5 }}>{title}</Typography>
      <Typography sx={{ color: 'text.secondary', fontSize: 13, maxWidth: 460, mx: 'auto' }}>{body}</Typography>
    </Box>
  );
}

export function SectionHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <Stack direction="row" alignItems="flex-start" spacing={2} sx={{ mb: 2 }}>
      <Box sx={{ flex: 1 }}>
        <Typography variant="h6">{title}</Typography>
        {subtitle && (
          <Typography sx={{ color: 'text.secondary', fontSize: 12.5, mt: 0.25 }}>{subtitle}</Typography>
        )}
      </Box>
      {action}
    </Stack>
  );
}

export function KeyValue({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Stack direction="row" spacing={1} sx={{ py: 0.35 }}>
      <Typography sx={{ width: 132, flexShrink: 0, fontSize: 12, color: 'text.secondary' }}>{label}</Typography>
      <Box sx={{ fontSize: 12.5, minWidth: 0, wordBreak: 'break-word' }}>{children}</Box>
    </Stack>
  );
}
