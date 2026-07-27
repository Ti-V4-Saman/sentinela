import * as React from 'react';
import {
  UserRound, UserRoundCheck, UserRoundX, Users as UsersIcon, Tag, Wand2,
  AlertCircle, SearchX, ChevronLeft, ChevronRight, RotateCw,
} from 'lucide-react';
import { SearchInput } from '@/components/input-group';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ContactTypeBadge, type ContactType } from '@/components/contacts/contact-type-badge';
import { IdentifyDialog, type ContactRow } from '@/components/contacts/identify-dialog';
import { ContactTypesDialog } from '@/components/contacts/contact-types-dialog';
import {
  listContacts, listContactTypes, identifyContact, clearContactIdentification, autoIdentifyContacts,
  listUsers, listTenants,
} from '../services/adminApi';
import { getUser } from '../services/authApi';
import { useToast } from '../components/ui/ToastProvider';
import { friendlyError } from '../utils/validation';

const PAGE_SIZE = 20;

function useDebounced<T>(value: T, delay = 350) {
  const [v, setV] = React.useState(value);
  React.useEffect(() => { const t = setTimeout(() => setV(value), delay); return () => clearTimeout(t); }, [value, delay]);
  return v;
}

type Counts = { total: number; identified: number; unidentified: number };
type TenantOption = { id: number; name: string };

export default function ContactsView() {
  const me = getUser();
  const isSuper = me?.role === 'superadmin';
  const toast = useToast();

  const [contacts, setContacts] = React.useState<ContactRow[]>([]);
  const [counts, setCounts] = React.useState<Counts>({ total: 0, identified: 0, unidentified: 0 });
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [reloadKey, setReloadKey] = React.useState(0);

  const [search, setSearch] = React.useState('');
  const [status, setStatus] = React.useState('ALL');
  const [typeFilter, setTypeFilter] = React.useState('ALL');
  const [tenantId, setTenantId] = React.useState<string>(''); // super escolhe o cliente
  const dSearch = useDebounced(search);

  const [types, setTypes] = React.useState<ContactType[]>([]);
  const [users, setUsers] = React.useState<{ id: number; name: string }[]>([]);
  const [tenants, setTenants] = React.useState<TenantOption[]>([]);

  const [identifying, setIdentifying] = React.useState<ContactRow | null>(null);
  const [typesOpen, setTypesOpen] = React.useState(false);

  const tid = isSuper ? (tenantId || undefined) : undefined;
  const needsTenant = isSuper && !tenantId;

  // Opções (tipos/usuários/tenants) — recarregam ao trocar de cliente (super).
  React.useEffect(() => {
    if (isSuper && tenants.length === 0) listTenants().then(setTenants).catch(() => {});
    if (needsTenant) { setTypes([]); setUsers([]); return; }
    listContactTypes(tid).then(setTypes).catch(() => {});
    listUsers(tid).then((u: { id: number; name: string }[]) => setUsers(u)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuper, tenantId, reloadKey]);

  const params = React.useMemo(() => ({
    page, limit: PAGE_SIZE,
    search: dSearch || undefined,
    status: status !== 'ALL' ? status : undefined,
    type_id: typeFilter !== 'ALL' ? typeFilter : undefined,
    tenantId: tid,
  }), [page, dSearch, status, typeFilter, tid]);

  React.useEffect(() => { setPage(1); }, [dSearch, status, typeFilter, tenantId]);

  React.useEffect(() => {
    if (needsTenant) { setContacts([]); setCounts({ total: 0, identified: 0, unidentified: 0 }); setTotal(0); setLoading(false); return; }
    let alive = true;
    setLoading(true); setError('');
    listContacts(params)
      .then((r: { total: number; counts: Counts; contacts: ContactRow[] }) => { if (!alive) return; setContacts(r.contacts); setCounts(r.counts); setTotal(r.total); })
      .catch((e: Error) => { if (alive) setError(friendlyError(e.message) || 'Falha ao carregar os contatos'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, reloadKey, needsTenant]);

  const refresh = () => setReloadKey((k) => k + 1);

  const doIdentify = async (body: Parameters<React.ComponentProps<typeof IdentifyDialog>['onSubmit']>[0]) => {
    if (!identifying) return;
    const r = await identifyContact(identifying.id, body);
    const extra = r.propagated ? ` ${r.propagated} contato(s) com o mesmo telefone também.` : '';
    toast.success('Contato identificado', `Identificação salva.${extra}`);
    refresh();
  };
  const doClear = async () => {
    if (!identifying) return;
    await clearContactIdentification(identifying.id, identifying.tenantId ? { tenantId: identifying.tenantId } : undefined);
    toast.success('Identificação removida', 'O contato voltou a não identificado.');
    refresh();
  };
  const runAuto = async () => {
    try {
      const r = await autoIdentifyContacts(tid ? { tenantId: tid } : {});
      toast.success('Autoidentificação concluída', `${r.propagated} contato(s) identificado(s) por telefone.`);
      refresh();
    } catch (e) {
      toast.error('Não foi possível autoidentificar', friendlyError((e as Error).message));
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtering = Boolean(dSearch || status !== 'ALL' || typeFilter !== 'ALL');
  const clearFilters = () => { setSearch(''); setStatus('ALL'); setTypeFilter('ALL'); };

  const StatCard = ({ icon: Icon, label, value, active, onClick, tone }: {
    icon: React.ComponentType<{ className?: string }>; label: string; value: number; active: boolean; onClick: () => void; tone: string;
  }) => (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`flex flex-1 items-center gap-3 rounded-lg border bg-card px-4 py-3 text-left shadow-[var(--shadow-card)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${active ? 'border-primary' : 'border-border hover:bg-muted/40'}`}
    >
      <span className={`flex h-9 w-9 items-center justify-center rounded-md ${tone}`}><Icon className="h-5 w-5" /></span>
      <span>
        <span className="block text-lg font-semibold text-foreground">{value}</span>
        <span className="block text-xs text-muted-foreground">{label}</span>
      </span>
    </button>
  );

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 lg:px-8">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-heading text-2xl font-semibold text-foreground">Contatos</h1>
          <p className="text-sm text-muted-foreground">Identifique contatos capturados e categorize por tipo</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {isSuper && (
            <Select value={tenantId} onValueChange={setTenantId}>
              <SelectTrigger className="w-[190px]" aria-label="Cliente"><SelectValue placeholder="Selecione o cliente" /></SelectTrigger>
              <SelectContent>
                {tenants.map((t) => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
          <Button variant="outline" onClick={() => setTypesOpen(true)} disabled={needsTenant}><Tag className="h-4 w-4" /> Tipos de contato</Button>
          <Button variant="outline" onClick={runAuto} disabled={needsTenant}><Wand2 className="h-4 w-4" /> Autoidentificar</Button>
        </div>
      </div>

      {needsTenant ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-border bg-card px-6 py-16 text-center shadow-[var(--shadow-card)]">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground"><UsersIcon className="h-6 w-6" /></div>
          <h3 className="text-base font-semibold text-foreground">Selecione um cliente</h3>
          <p className="max-w-sm text-sm text-muted-foreground">Escolha um cliente acima para ver e identificar seus contatos.</p>
        </div>
      ) : (
        <>
          {/* Contadores (também filtram por status) */}
          <div className="mb-4 flex flex-col gap-3 sm:flex-row">
            <StatCard icon={UserRound} label="Total de contatos" value={counts.total} tone="bg-muted text-muted-foreground"
              active={status === 'ALL'} onClick={() => setStatus('ALL')} />
            <StatCard icon={UserRoundCheck} label="Identificados" value={counts.identified} tone="bg-success/10 text-success"
              active={status === 'identified'} onClick={() => setStatus('identified')} />
            <StatCard icon={UserRoundX} label="Não identificados" value={counts.unidentified} tone="bg-warning/10 text-warning"
              active={status === 'unidentified'} onClick={() => setStatus('unidentified')} />
          </div>

          {/* Filtros */}
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <SearchInput value={search} onChange={setSearch} placeholder="Buscar por nome, telefone ou exibição…" className="flex-1 sm:max-w-sm" />
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="w-full sm:w-[180px]" aria-label="Filtrar por tipo"><SelectValue placeholder="Tipo" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Todos os tipos</SelectItem>
                {types.map((t) => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {filtering && <Button variant="ghost" size="sm" onClick={clearFilters}>Limpar filtros</Button>}
            <Button variant="outline" size="icon" onClick={refresh} aria-label="Atualizar"><RotateCw className="h-4 w-4" /></Button>
          </div>

          {/* Conteúdo */}
          <div className="overflow-hidden rounded-lg border border-border bg-card shadow-[var(--shadow-card)]">
            {error ? (
              <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive"><AlertCircle className="h-6 w-6" /></div>
                <h3 className="text-base font-semibold text-foreground">Não foi possível carregar</h3>
                <p className="max-w-sm text-sm text-muted-foreground">{error}</p>
                <Button variant="outline" size="sm" onClick={refresh}>Tentar novamente</Button>
              </div>
            ) : loading ? (
              <div className="divide-y divide-border">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-4 px-4 py-4">
                    <Skeleton className="h-4 w-44" /><Skeleton className="h-4 w-28" /><Skeleton className="ml-auto h-8 w-24 rounded-md" />
                  </div>
                ))}
              </div>
            ) : contacts.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  {filtering ? <SearchX className="h-6 w-6" /> : <UserRound className="h-6 w-6" />}
                </div>
                <h3 className="text-base font-semibold text-foreground">{filtering ? 'Nenhum resultado' : 'Nenhum contato'}</h3>
                <p className="max-w-sm text-sm text-muted-foreground">
                  {filtering ? 'Nenhum contato bate com os filtros.' : 'Sem contatos capturados para este cliente ainda.'}
                </p>
                {filtering && <Button variant="outline" size="sm" onClick={clearFilters}>Limpar filtros</Button>}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Contato</TableHead>
                    <TableHead>Telefone</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead>Identificação</TableHead>
                    <TableHead className="text-center">Msgs</TableHead>
                    <TableHead className="text-right">Ação</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {contacts.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium text-foreground">
                        <span className="block">{c.displayName || c.name || '—'}</span>
                        {c.displayName && c.name && c.displayName !== c.name && (
                          <span className="block text-xs font-normal text-muted-foreground">orig.: {c.name}</span>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{c.phone || '—'}</TableCell>
                      <TableCell>{c.type ? <ContactTypeBadge type={c.type} /> : <span className="text-sm text-muted-foreground">—</span>}</TableCell>
                      <TableCell>
                        {c.identified ? (
                          <StatusBadge tone={c.identificationSource === 'auto' ? 'info' : 'success'}>
                            {c.identificationSource === 'auto' ? 'Auto' : 'Identificado'}
                          </StatusBadge>
                        ) : (
                          <StatusBadge tone="warning">Não identificado</StatusBadge>
                        )}
                      </TableCell>
                      <TableCell className="text-center text-sm text-muted-foreground">{(c as ContactRow & { messageCount?: number }).messageCount ?? 0}</TableCell>
                      <TableCell className="text-right">
                        <Button variant="outline" size="sm" onClick={() => setIdentifying(c)}>
                          <UserRoundCheck className="h-3.5 w-3.5" /> {c.identified ? 'Editar' : 'Identificar'}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>

          {!loading && !error && total > 0 && (
            <div className="mt-3 flex flex-col items-center justify-between gap-3 sm:flex-row">
              <p className="text-xs text-muted-foreground">{contacts.length} de {total} contato(s)</p>
              {totalPages > 1 && (
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="icon" aria-label="Página anterior" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}><ChevronLeft className="h-4 w-4" /></Button>
                  <span className="text-xs text-muted-foreground">Página {page} de {totalPages}</span>
                  <Button variant="outline" size="icon" aria-label="Próxima página" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}><ChevronRight className="h-4 w-4" /></Button>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {identifying && (
        <IdentifyDialog
          contact={identifying}
          types={types}
          users={users}
          onClose={() => setIdentifying(null)}
          onSubmit={doIdentify}
          onClear={doClear}
        />
      )}
      {typesOpen && (
        <ContactTypesDialog
          isSuper={isSuper}
          tenantId={tid ? Number(tid) : null}
          toast={toast}
          onClose={() => { setTypesOpen(false); refresh(); }}
        />
      )}
    </main>
  );
}
