import { useEffect, useState } from 'react';
import {
  Box,
  Card,
  Drawer,
  IconButton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/CloseOutlined';
import type { Api } from '../api.ts';
import type { ExecutionRecord } from '@utcp-browser-session/shared';
import { EmptyState, JsonBlock, KeyValue, MethodChip, SectionHeader, StatusChip } from '../components.tsx';

export default function Executions({ api }: { api: Api }) {
  const [executions, setExecutions] = useState<ExecutionRecord[]>([]);
  const [selected, setSelected] = useState<ExecutionRecord | null>(null);

  useEffect(() => {
    const load = () => void api.executions(100).then((result) => setExecutions(result.executions)).catch(() => undefined);
    load();
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [api]);

  return (
    <Box>
      <SectionHeader
        title="Executions"
        subtitle="Every invocation, its outcome and latency. Request headers and cookies are never recorded."
      />
      <Card>
        {executions.length === 0 ? (
          <EmptyState
            title="No executions yet"
            body="Calls made by a UTCP client or from the tool inspector appear here with sanitized metadata."
          />
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Tool</TableCell>
                <TableCell>Endpoint</TableCell>
                <TableCell>Outcome</TableCell>
                <TableCell align="right">HTTP</TableCell>
                <TableCell align="right">Latency</TableCell>
                <TableCell>Actor</TableCell>
                <TableCell>Time</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {executions.map((execution) => (
                <TableRow key={execution.id} hover sx={{ cursor: 'pointer' }} onClick={() => setSelected(execution)}>
                  <TableCell sx={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11.5 }}>{execution.toolName}</TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.75} alignItems="center">
                      <MethodChip method={execution.method || 'GET'} />
                      <Typography sx={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11 }} noWrap>
                        {execution.path}
                      </Typography>
                    </Stack>
                  </TableCell>
                  <TableCell><StatusChip status={execution.outcome} /></TableCell>
                  <TableCell align="right" sx={{ fontSize: 12 }}>{execution.httpStatus ?? '—'}</TableCell>
                  <TableCell align="right" sx={{ fontSize: 12 }}>{execution.latencyMs != null ? `${Math.round(execution.latencyMs)} ms` : '—'}</TableCell>
                  <TableCell sx={{ fontSize: 11.5, color: 'text.secondary' }}>{execution.actor}</TableCell>
                  <TableCell sx={{ fontSize: 11.5, color: 'text.secondary' }}>{new Date(execution.startedAt).toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Drawer
        anchor="right"
        open={!!selected}
        onClose={() => setSelected(null)}
        PaperProps={{ sx: { width: { xs: '100%', sm: 560 }, backgroundColor: '#0d1424', backgroundImage: 'none' } }}
      >
        {selected && (
          <Box sx={{ p: 2.5 }}>
            <Stack direction="row" alignItems="center" spacing={1}>
              <Typography variant="h6" sx={{ flex: 1, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 15 }}>
                {selected.toolName}
              </Typography>
              <IconButton size="small" onClick={() => setSelected(null)}>
                <CloseIcon fontSize="small" />
              </IconButton>
            </Stack>
            <Stack direction="row" spacing={0.75} sx={{ mt: 1, mb: 1.5 }}>
              <StatusChip status={selected.outcome} />
              <MethodChip method={selected.method || 'GET'} />
              <Typography sx={{ fontSize: 12, color: 'text.secondary', alignSelf: 'center' }}>{selected.path}</Typography>
            </Stack>

            <Stack spacing={0.2}>
              <KeyValue label="Execution id">{selected.id}</KeyValue>
              <KeyValue label="Actor">{selected.actor}</KeyValue>
              <KeyValue label="HTTP status">{selected.httpStatus ?? '—'}</KeyValue>
              <KeyValue label="Latency">{selected.latencyMs != null ? `${Math.round(selected.latencyMs)} ms` : '—'}</KeyValue>
              <KeyValue label="Request size">{selected.requestBytes != null ? `${selected.requestBytes} B` : '—'}</KeyValue>
              <KeyValue label="Response size">
                {selected.responseBytes != null ? `${selected.responseBytes} B` : '—'}
                {selected.truncated ? ' (truncated)' : ''}
              </KeyValue>
              <KeyValue label="Started">{new Date(selected.startedAt).toLocaleString()}</KeyValue>
              {selected.errorCode && <KeyValue label="Error code">{selected.errorCode}</KeyValue>}
              {selected.errorMessage && <KeyValue label="Error">{selected.errorMessage}</KeyValue>}
            </Stack>

            <Typography sx={{ mt: 2, mb: 0.75, fontSize: 12, color: 'text.secondary' }}>
              Response preview (redacted, first 1500 bytes)
            </Typography>
            {selected.responsePreview ? (
              <JsonBlock value={safeParse(selected.responsePreview)} maxHeight={340} />
            ) : (
              <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>No body was returned.</Typography>
            )}
          </Box>
        )}
      </Drawer>
    </Box>
  );
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
