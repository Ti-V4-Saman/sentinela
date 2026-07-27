import * as React from 'react';
import {
  ScrollText, Loader2, AlertCircle, SearchX, ChevronLeft, ChevronRight, RotateCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { StatusBadge } from '@/components/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { listAudit, listTenants } from '../services/adminApi';
import { getUser } from '../services/authApi';
import { friendlyError } from '../utils/validation';

const PAGE = 20;

const ACTION_LABELS: Record<string, string> = {
  login: 'Login', login_failed: 'Falha de login', view_thread: 'Abriu conversa',
  identify_contact: 'Identificou contato', clear_identification: 'Removeu identificação',
  create_contact_type: 'Criou tipo', update_contact_type: 'Editou tipo', delete_contact_type: 'Excluiu tipo',
  set_capture_wid: 'Mapeou captura', link_user_instance: 'Vinculou instância a usuário',
  unlink_user_instance: 'Desvinculou instância de usuário', link_team_instance: 'Vinculou instância a equipe',
  unlink_team_instance: 'Desvinculou instância de equipe', export: 'Exportou relatório',
};
const ACTIONS = Object.keys(ACTION_LABELS);
const ROLE_LABELS: Record<string, string> = { superadmin: 'Superadmin', admin: 'Administrador', gestor: 'Gestor', usuario: 'Usuário' };

function fmt(iso?: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function AuditView() {
  const me = getUser();
  const isSuper = me?.role === 'superadmin';

  const [logs, setLogs] = React.useState<any[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [reloadKey, setReloadKey] = React.useState(0);

  const [action, setAction] = React.useState('ALL');
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  const [tenantId, setTenantId] = React.useState('ALL');
  const [tenants, setTenants] = React.useState<{ id: number; name: string }[]>([]);

  React.useEffect(() => { if (isSuper) listTenants().then(setTenants).catch(() => {}); }, [isSuper]);

  const params = React.useMemo(() => ({
    page, limit: PAGE,
    action: action !== 'ALL' ? action : undefined,
    from: from || undefined, to: to || undefined,
    tenant_id: isSuper && tenantId !== 'ALL' ? tenantId : undefined,
  }), [page, action, from, to, isSuper, tenantId]);

  React.useEffect(() => { setPage(1); }, [action, from, to, tenantId]);

  React.useEffect(() => {
    let alive = true;
    setLoading(true); setError('');
    listAudit(params)
      .then((r: { total: number; logs: any[] }) => { if (!alive) return; setLogs(r.logs); setTotal(r.total); })
      .catch((e: Error) => { if (alive) setError(friendlyError(e.message) || 'Falha ao carregar a auditoria'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [params, reloadKey]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE));
  const filtering = action !== 'ALL' || !!from || !!to || (isSuper && tenantId !== 'ALL');

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 lg:px-8">
      <div className="mb-6">
        <h1 className="font-heading text-2xl font-semibold text-foreground">Auditoria</h1>
        <p className="text-sm text-muted-foreground">Registro de acessos e alterações · somente leitura</p>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select value={action} onValueChange={setAction}>
          <SelectTrigger className="w-[220px]" aria-label="Filtrar por ação"><SelectValue placeholder="Ação" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Todas as ações</SelectItem>
            {ACTIONS.map((a) => <SelectItem key={a} value={a}>{ACTION_LABELS[a]}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-[150px]" aria-label="Data inicial" />
          <span className="text-xs text-muted-foreground">até</span>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-[150px]" aria-label="Data final" />
        </div>
        {isSuper && (
          <Select value={tenantId} onValueChange={setTenantId}>
            <SelectTrigger className="w-[190px]" aria-label="Cliente"><SelectValue placeholder="Cliente" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">Todos os clientes</SelectItem>
              {tenants.map((t) => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
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
        ) : logs.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">{filtering ? <SearchX className="h-6 w-6" /> : <ScrollText className="h-6 w-6" />}</div>
            <h3 className="text-base font-semibold text-foreground">{filtering ? 'Nenhum resultado' : 'Nenhum registro'}</h3>
            <p className="max-w-sm text-sm text-muted-foreground">{filtering ? 'Nenhum evento bate com os filtros.' : 'Ainda não há eventos de auditoria.'}</p>
          </div>
        ) : (
          <Table>
            <TableHeader><TableRow>
              <TableHead>Quando</TableHead><TableHead>Ator</TableHead><TableHead>Ação</TableHead>
              <TableHead>Recurso</TableHead><TableHead>Status</TableHead><TableHead>IP</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {logs.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="text-sm text-muted-foreground">{fmt(l.createdAt)}</TableCell>
                  <TableCell className="text-sm text-foreground">
                    {l.actor ? <>{l.actor.name || `#${l.actor.id}`}<span className="block text-xs text-muted-foreground">{ROLE_LABELS[l.actor.role] || l.actor.role}</span></> : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="text-sm text-foreground">{ACTION_LABELS[l.action] || l.action}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{l.resource}{l.resourceId ? <span className="font-mono text-xs"> · {l.resourceId}</span> : ''}</TableCell>
                  <TableCell><StatusBadge tone={l.status === 'fail' ? 'destructive' : 'success'}>{l.status === 'fail' ? 'Falha' : 'OK'}</StatusBadge></TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{l.ip || '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {!loading && !error && total > 0 && (
        <div className="mt-3 flex items-center justify-between">
          <p className="text-xs text-muted-foreground">{logs.length} de {total} registro(s)</p>
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
