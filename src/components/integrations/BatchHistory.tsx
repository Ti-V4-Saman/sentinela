import * as React from 'react';
import {
  History, AlertCircle, RotateCw, ChevronDown, ChevronRight, ChevronLeft, Send, Inbox,
} from 'lucide-react';
import { StatusBadge, type StatusTone } from '@/components/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Tooltip, TooltipContent, TooltipTrigger, TooltipProvider,
} from '@/components/ui/tooltip';
import {
  listIntegrationBatches, listIntegrationAttempts, resendIntegrationBatch,
} from '../../services/adminApi';
import { useToast } from '../ui/ToastProvider';
import { friendlyError } from '../../utils/validation';

const PAGE_SIZE = 20;

type Batch = {
  id: number;
  window_start: string;
  window_end: string;
  status: 'pending' | 'delivering' | 'delivered' | 'failed';
  part: number;
  part_total: number;
  conversation_count: number;
  message_count: number;
};

type Attempt = {
  id: number;
  attempt_no: number;
  status: 'success' | 'failure';
  http_code: number | null;
  duration_ms: number | null;
  error: string | null;
};

type Confirm = (o: {
  title: string; description?: string; variant?: 'danger' | 'warning'; confirmLabel?: string;
}) => Promise<boolean>;

const STATUS_LABEL: Record<Batch['status'], string> = {
  pending: 'Pendente', delivering: 'Enviando', delivered: 'Entregue', failed: 'Falhou',
};
const STATUS_TONE: Record<Batch['status'], StatusTone> = {
  pending: 'neutral', delivering: 'info', delivered: 'success', failed: 'destructive',
};

function formatDateTime(v: string) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

// Um lote pode estar `failed` porque o ambiente tem a integração externa desligada (nenhuma
// tentativa real de rede ocorreu) — isso é bem diferente de uma falha HTTP real e precisa ficar
// visualmente distinto para não parecer um problema no destino do cliente.
function isDisabledFailure(attempts: Attempt[] | undefined) {
  if (!attempts || attempts.length === 0) return false;
  const last = attempts[attempts.length - 1];
  return last.error === 'EXTERNAL_INTEGRATIONS_DISABLED';
}

function AttemptsPanel({ tenantId, batchId }: { tenantId?: number; batchId: number }) {
  const [attempts, setAttempts] = React.useState<Attempt[] | null>(null);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    let cancelled = false;
    listIntegrationAttempts(tenantId, batchId)
      .then((res) => { if (!cancelled) setAttempts(res.attempts || []); })
      .catch((e) => { if (!cancelled) setError(friendlyError(e.message)); });
    return () => { cancelled = true; };
  }, [tenantId, batchId]);

  if (error) {
    return <p className="px-4 py-3 text-xs text-destructive">{error}</p>;
  }
  if (!attempts) {
    return (
      <div className="space-y-1.5 px-4 py-3">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }
  if (attempts.length === 0) {
    return <p className="px-4 py-3 text-xs text-muted-foreground">Nenhuma tentativa de entrega registrada ainda.</p>;
  }

  return (
    <div className="px-4 py-3">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Tentativa</TableHead>
            <TableHead>Resultado</TableHead>
            <TableHead>HTTP</TableHead>
            <TableHead>Duração</TableHead>
            <TableHead>Erro</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {attempts.map((a) => {
            const disabled = a.error === 'EXTERNAL_INTEGRATIONS_DISABLED';
            return (
              <TableRow key={a.id}>
                <TableCell className="text-sm text-muted-foreground">#{a.attempt_no}</TableCell>
                <TableCell>
                  <StatusBadge tone={a.status === 'success' ? 'success' : (disabled ? 'neutral' : 'destructive')}>
                    {a.status === 'success' ? 'Sucesso' : (disabled ? 'Desativado no ambiente' : 'Falha')}
                  </StatusBadge>
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{a.http_code ?? '—'}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{a.duration_ms != null ? `${a.duration_ms} ms` : '—'}</TableCell>
                <TableCell className="max-w-xs truncate text-xs text-muted-foreground" title={a.error || undefined}>
                  {disabled ? 'Integração externa desativada no ambiente' : (a.error || '—')}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

export function BatchHistory({
  tenantId, externalEnabled, confirm,
}: {
  tenantId?: number;
  externalEnabled: boolean;
  confirm: Confirm;
}) {
  const toast = useToast();
  const [batches, setBatches] = React.useState<Batch[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState('');
  const [expanded, setExpanded] = React.useState<number | null>(null);
  const [resendingId, setResendingId] = React.useState<number | null>(null);
  // Marca lotes cujo último erro é o desligamento de ambiente, para o badge da linha principal
  // (evita reconsultar attempts para todo mundo — só quando a linha é expandida uma vez).
  const [disabledBatches, setDisabledBatches] = React.useState<Record<number, boolean>>({});

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const load = React.useCallback(async (opts?: { silent?: boolean }) => {
    if (opts?.silent) setRefreshing(true); else setLoading(true);
    setError('');
    try {
      const res = await listIntegrationBatches(tenantId, { page, limit: PAGE_SIZE });
      setBatches(res.batches || []);
      setTotal(res.total || 0);
    } catch (e) {
      const msg = friendlyError((e as Error).message) || 'Falha ao carregar o histórico de lotes';
      if (opts?.silent) toast.error('Não foi possível atualizar', msg); else setError(msg);
    } finally {
      if (opts?.silent) setRefreshing(false); else setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, page]);

  React.useEffect(() => { load(); }, [load]);

  const toggleExpand = async (batch: Batch) => {
    const next = expanded === batch.id ? null : batch.id;
    setExpanded(next);
    if (next != null && disabledBatches[batch.id] === undefined && batch.status === 'failed') {
      try {
        const res = await listIntegrationAttempts(tenantId, batch.id);
        setDisabledBatches((m) => ({ ...m, [batch.id]: isDisabledFailure(res.attempts) }));
      } catch {
        // Silencioso — o painel expandido já mostra o próprio erro de carregamento.
      }
    }
  };

  const resend = async (batch: Batch) => {
    const ok = await confirm({
      title: `Reenviar o lote da parte ${batch.part}/${batch.part_total}?`,
      description: `Período de ${formatDateTime(batch.window_start)} a ${formatDateTime(batch.window_end)}. Uma nova tentativa de entrega será registrada.`,
      variant: 'warning',
      confirmLabel: 'Reenviar',
    });
    if (!ok) return;
    setResendingId(batch.id);
    try {
      await resendIntegrationBatch(tenantId, batch.id);
      toast.success('Reenvio concluído', 'O lote foi reenviado ao destino configurado.');
      await load({ silent: true });
    } catch (e) {
      toast.error('Não foi possível reenviar', friendlyError((e as Error).message));
    } finally {
      setResendingId(null);
    }
  };

  const resendDisabledReason = (batch: Batch): string | null => {
    if (!externalEnabled) return 'Integração externa desativada no ambiente';
    if (batch.status === 'delivering') return 'Lote já está em entrega';
    return null;
  };

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card shadow-[var(--shadow-card)]">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-muted-foreground" />
          <h2 className="font-heading text-base font-semibold text-foreground">Histórico de lotes</h2>
        </div>
        <Button variant="outline" size="icon" onClick={() => load({ silent: true })} aria-label="Atualizar histórico">
          <RotateCw className={refreshing ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
        </Button>
      </div>

      {error ? (
        <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <AlertCircle className="h-6 w-6" />
          </div>
          <h3 className="text-base font-semibold text-foreground">Não foi possível carregar</h3>
          <p className="max-w-sm text-sm text-muted-foreground">{error}</p>
          <Button variant="outline" size="sm" onClick={() => load()}>Tentar novamente</Button>
        </div>
      ) : loading ? (
        <div className="divide-y divide-border">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-4">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-5 w-24 rounded-full" />
              <Skeleton className="h-4 w-16" />
              <Skeleton className="ml-auto h-8 w-8 rounded-md" />
            </div>
          ))}
        </div>
      ) : batches.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Inbox className="h-6 w-6" />
          </div>
          <h3 className="text-base font-semibold text-foreground">Nenhum lote ainda</h3>
          <p className="max-w-sm text-sm text-muted-foreground">
            Os lotes aparecem aqui após o primeiro envio diário agendado.
          </p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Período</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Parte</TableHead>
              <TableHead>Conversas</TableHead>
              <TableHead>Mensagens</TableHead>
              <TableHead className="text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {batches.map((b) => {
              const isOpen = expanded === b.id;
              const disabledFailure = b.status === 'failed' && disabledBatches[b.id];
              const reason = resendDisabledReason(b);
              return (
                <React.Fragment key={b.id}>
                  <TableRow className="cursor-pointer" onClick={() => toggleExpand(b)}>
                    <TableCell>
                      <Button variant="ghost" size="icon-sm" aria-label={isOpen ? 'Recolher tentativas' : 'Expandir tentativas'} onClick={(e) => { e.stopPropagation(); toggleExpand(b); }}>
                        {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </Button>
                    </TableCell>
                    <TableCell className="text-sm text-foreground">
                      {formatDateTime(b.window_start)} – {formatDateTime(b.window_end)}
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={disabledFailure ? 'neutral' : STATUS_TONE[b.status]}>
                        {disabledFailure ? 'Desativado no ambiente' : STATUS_LABEL[b.status]}
                      </StatusBadge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{b.part}/{b.part_total}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{b.conversation_count}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{b.message_count}</TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span>
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={!!reason || resendingId === b.id}
                                onClick={() => resend(b)}
                              >
                                <Send className="h-4 w-4" /> {resendingId === b.id ? 'Reenviando…' : 'Reenviar'}
                              </Button>
                            </span>
                          </TooltipTrigger>
                          {reason && <TooltipContent>{reason}</TooltipContent>}
                        </Tooltip>
                      </TooltipProvider>
                    </TableCell>
                  </TableRow>
                  {isOpen && (
                    <TableRow>
                      <TableCell colSpan={7} className="bg-muted/30 p-0">
                        <AttemptsPanel tenantId={tenantId} batchId={b.id} />
                      </TableCell>
                    </TableRow>
                  )}
                </React.Fragment>
              );
            })}
          </TableBody>
        </Table>
      )}

      {!loading && !error && batches.length > 0 && totalPages > 1 && (
        <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
          <p className="text-xs text-muted-foreground">{total} lote(s) no total</p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" aria-label="Página anterior" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-xs text-muted-foreground">Página {page} de {totalPages}</span>
            <Button variant="outline" size="icon" aria-label="Próxima página" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
