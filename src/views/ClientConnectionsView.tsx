import * as React from 'react';
import {
  Radio, Wifi, WifiOff, CheckCircle2, CircleSlash, Loader2, AlertCircle, ChevronLeft, ChevronRight, RotateCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { listClientInstances } from '../services/adminApi';
import { friendlyError } from '../utils/validation';

const PAGE = 20;

// Mascara o número, mostrando só os últimos 4 dígitos (não expõe o número completo).
function maskPhone(p?: string | null) {
  if (!p) return '—';
  const digits = String(p).replace(/\D/g, '');
  if (digits.length < 4) return '••••';
  return `••••••${digits.slice(-4)}`;
}

type Inst = { id: string; name: string; status: string; phoneNumber: string | null; captureMapped: boolean; owner: { name: string | null } | null; teamCount: number };

// Conexões de um cliente para o superadmin no MODO CLIENTE — SOMENTE LEITURA e campos seguros.
// Reusa /api/clients/:id/instances (não retorna token/webhook/capture_wid cru).
export default function ClientConnectionsView({ tenantId }: { tenantId: number }) {
  const [items, setItems] = React.useState<Inst[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [reloadKey, setReloadKey] = React.useState(0);

  React.useEffect(() => {
    let alive = true;
    setLoading(true); setError('');
    listClientInstances(tenantId, { page, limit: PAGE })
      .then((r: { total: number; instances: Inst[] }) => { if (!alive) return; setItems(r.instances); setTotal(r.total); })
      .catch((e: Error) => { if (alive) setError(friendlyError(e.message) || 'Falha ao carregar as conexões'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [tenantId, page, reloadKey]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 lg:px-8">
      <div className="mb-6 flex items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-semibold text-foreground">Conexões</h1>
          <p className="text-sm text-muted-foreground">Conexões do cliente · somente leitura</p>
        </div>
        <Button variant="outline" size="icon" onClick={() => setReloadKey((k) => k + 1)} aria-label="Atualizar"><RotateCw className="h-4 w-4" /></Button>
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-[var(--shadow-card)]">
        {error ? (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive"><AlertCircle className="h-6 w-6" /></div>
            <p className="max-w-sm text-sm text-muted-foreground">{error}</p>
            <Button variant="outline" size="sm" onClick={() => setReloadKey((k) => k + 1)}>Tentar novamente</Button>
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground"><Radio className="h-6 w-6" /></div>
            <h3 className="text-base font-semibold text-foreground">Nenhuma conexão</h3>
            <p className="max-w-sm text-sm text-muted-foreground">Este cliente ainda não tem conexões cadastradas.</p>
          </div>
        ) : (
          <Table>
            <TableHeader><TableRow>
              <TableHead>Conexão</TableHead><TableHead>Número</TableHead><TableHead>Status</TableHead>
              <TableHead>Captura</TableHead><TableHead>Proprietário</TableHead><TableHead className="text-center">Equipes</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {items.map((i) => (
                <TableRow key={i.id}>
                  <TableCell className="font-medium text-foreground">{i.name}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{maskPhone(i.phoneNumber)}</TableCell>
                  <TableCell>
                    <StatusBadge tone={i.status === 'Connected' ? 'success' : 'neutral'}>
                      {i.status === 'Connected' ? <><Wifi className="h-3 w-3" /> Conectada</> : <><WifiOff className="h-3 w-3" /> {i.status}</>}
                    </StatusBadge>
                  </TableCell>
                  <TableCell>
                    <StatusBadge tone={i.captureMapped ? 'info' : 'warning'}>
                      {i.captureMapped ? <><CheckCircle2 className="h-3 w-3" /> Mapeada</> : <><CircleSlash className="h-3 w-3" /> Não mapeada</>}
                    </StatusBadge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{i.owner?.name || '—'}</TableCell>
                  <TableCell className="text-center text-sm text-muted-foreground">{i.teamCount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {!loading && !error && total > 0 && (
        <div className="mt-3 flex items-center justify-between">
          <p className="text-xs text-muted-foreground">{items.length} de {total} conexão(ões)</p>
          {totalPages > 1 && (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="icon" aria-label="Página anterior" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}><ChevronLeft className="h-4 w-4" /></Button>
              <span className="text-xs text-muted-foreground">Página {page} de {totalPages}</span>
              <Button variant="outline" size="icon" aria-label="Próxima página" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}><ChevronRight className="h-4 w-4" /></Button>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
