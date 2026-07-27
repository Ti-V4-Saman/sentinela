import * as React from 'react';
import {
  ArrowLeft, Radio, MessageSquare, MessagesSquare, Users as UsersIcon, UsersRound, Contact,
  Loader2, AlertCircle, ChevronLeft, ChevronRight, Link2, Wifi, WifiOff, CheckCircle2, CircleSlash,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatusBadge, type StatusTone } from '@/components/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ContactTypeBadge } from '@/components/contacts/contact-type-badge';
import ConversationsView from './ConversationsView';
import {
  getClientOverview, listClientInstances, listClientUsers, listClientTeams, listClientContacts,
} from '../services/adminApi';
import { friendlyError } from '../utils/validation';

const PAGE = 20;
const ROLE_LABELS: Record<string, string> = { superadmin: 'Superadmin', admin: 'Administrador', gestor: 'Gestor', usuario: 'Usuário' };

type Client = { id: number; name: string; status?: string };

// Hook de paginação server-side genérico para as tabelas do drill-down.
function usePaged<T>(fetcher: (params: { page: number; limit: number }) => Promise<{ total: number } & Record<string, unknown>>, key: string, extraDep?: unknown) {
  const [items, setItems] = React.useState<T[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  React.useEffect(() => { setPage(1); }, [extraDep]);
  React.useEffect(() => {
    let alive = true;
    setLoading(true); setError('');
    fetcher({ page, limit: PAGE })
      .then((r) => { if (!alive) return; setItems((r[key] as T[]) || []); setTotal(r.total); })
      .catch((e: Error) => { if (alive) setError(friendlyError(e.message) || 'Falha ao carregar'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, extraDep]);
  return { items, total, page, setPage, loading, error };
}

function Pager({ page, total, setPage }: { page: number; total: number; setPage: (f: (p: number) => number) => void }) {
  const totalPages = Math.max(1, Math.ceil(total / PAGE));
  if (totalPages <= 1) return <p className="mt-3 text-xs text-muted-foreground">{total} registro(s)</p>;
  return (
    <div className="mt-3 flex items-center justify-between">
      <p className="text-xs text-muted-foreground">{total} registro(s)</p>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="icon" aria-label="Página anterior" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}><ChevronLeft className="h-4 w-4" /></Button>
        <span className="text-xs text-muted-foreground">Página {page} de {totalPages}</span>
        <Button variant="outline" size="icon" aria-label="Próxima página" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}><ChevronRight className="h-4 w-4" /></Button>
      </div>
    </div>
  );
}

function PanelShell({ loading, error, empty, emptyText, children }: { loading: boolean; error: string; empty: boolean; emptyText: string; children: React.ReactNode }) {
  if (loading) return <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  if (error) return (
    <div className="flex flex-col items-center gap-2 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive"><AlertCircle className="h-6 w-6" /></div>
      <p className="text-sm text-muted-foreground">{error}</p>
    </div>
  );
  if (empty) return <div className="py-16 text-center text-sm text-muted-foreground">{emptyText}</div>;
  return <>{children}</>;
}

function InstancesPanel({ id }: { id: number }) {
  type Inst = { id: string; name: string; status: string; phoneNumber: string | null; captureMapped: boolean; owner: { name: string | null } | null; teamCount: number };
  const { items, total, page, setPage, loading, error } = usePaged<Inst>((p) => listClientInstances(id, p), 'instances');
  return (
    <>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <PanelShell loading={loading} error={error} empty={items.length === 0} emptyText="Nenhuma instância neste cliente.">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Instância</TableHead><TableHead>Telefone</TableHead><TableHead>Status</TableHead>
              <TableHead>Captura</TableHead><TableHead>Dono</TableHead><TableHead className="text-center">Equipes</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {items.map((i) => (
                <TableRow key={i.id}>
                  <TableCell className="font-medium text-foreground">{i.name}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{i.phoneNumber || '—'}</TableCell>
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
        </PanelShell>
      </div>
      {!loading && !error && <Pager page={page} total={total} setPage={setPage} />}
    </>
  );
}

function UsersPanel({ id }: { id: number }) {
  type U = { id: number; name: string; email: string; role: string; status: string };
  const { items, total, page, setPage, loading, error } = usePaged<U>((p) => listClientUsers(id, p), 'users');
  return (
    <>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <PanelShell loading={loading} error={error} empty={items.length === 0} emptyText="Nenhum usuário neste cliente.">
          <Table>
            <TableHeader><TableRow><TableHead>Nome</TableHead><TableHead>E-mail</TableHead><TableHead>Papel</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
            <TableBody>
              {items.map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="font-medium text-foreground">{u.name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{u.email}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{ROLE_LABELS[u.role] || u.role}</TableCell>
                  <TableCell><StatusBadge tone={u.status === 'active' ? 'success' : 'warning'}>{u.status === 'active' ? 'Ativo' : 'Desativado'}</StatusBadge></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </PanelShell>
      </div>
      {!loading && !error && <Pager page={page} total={total} setPage={setPage} />}
    </>
  );
}

function TeamsPanel({ id }: { id: number }) {
  type T = { id: number; name: string; userCount: number; managerCount: number; instanceCount: number };
  const { items, total, page, setPage, loading, error } = usePaged<T>((p) => listClientTeams(id, p), 'teams');
  return (
    <>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <PanelShell loading={loading} error={error} empty={items.length === 0} emptyText="Nenhuma equipe neste cliente.">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Equipe</TableHead><TableHead className="text-center">Membros</TableHead>
              <TableHead className="text-center">Gestores</TableHead><TableHead className="text-center">Instâncias</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {items.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium text-foreground"><span className="inline-flex items-center gap-2"><UsersRound className="h-3.5 w-3.5 text-muted-foreground" />{t.name}</span></TableCell>
                  <TableCell className="text-center text-sm text-muted-foreground">{t.userCount}</TableCell>
                  <TableCell className="text-center text-sm text-muted-foreground">{t.managerCount}</TableCell>
                  <TableCell className="text-center text-sm text-muted-foreground"><span className="inline-flex items-center gap-1"><Link2 className="h-3 w-3" />{t.instanceCount}</span></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </PanelShell>
      </div>
      {!loading && !error && <Pager page={page} total={total} setPage={setPage} />}
    </>
  );
}

function ContactsPanel({ id }: { id: number }) {
  type C = { id: string; name: string | null; displayName: string | null; phone: string | null; identified: boolean; identificationSource: string | null; type: { id: number; name: string; color?: string | null } | null };
  const [status, setStatus] = React.useState('ALL');
  const { items, total, page, setPage, loading, error } = usePaged<C>(
    (p) => listClientContacts(id, { ...p, status: status !== 'ALL' ? status : undefined }), 'contacts', status);
  return (
    <>
      <div className="mb-3">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[200px]" aria-label="Filtrar contatos"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Todos os contatos</SelectItem>
            <SelectItem value="identified">Identificados</SelectItem>
            <SelectItem value="pending">Pendentes</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <PanelShell loading={loading} error={error} empty={items.length === 0} emptyText="Nenhum contato neste cliente.">
          <Table>
            <TableHeader><TableRow><TableHead>Contato</TableHead><TableHead>Telefone</TableHead><TableHead>Tipo</TableHead><TableHead>Identificação</TableHead></TableRow></TableHeader>
            <TableBody>
              {items.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium text-foreground">{c.displayName || c.name || '—'}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{c.phone || '—'}</TableCell>
                  <TableCell>{c.type ? <ContactTypeBadge type={c.type} /> : <span className="text-sm text-muted-foreground">—</span>}</TableCell>
                  <TableCell>
                    {c.identified
                      ? <StatusBadge tone={c.identificationSource === 'auto' ? 'info' : 'success'}>{c.identificationSource === 'auto' ? 'Auto' : 'Identificado'}</StatusBadge>
                      : <StatusBadge tone="warning">Pendente</StatusBadge>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </PanelShell>
      </div>
      {!loading && !error && <Pager page={page} total={total} setPage={setPage} />}
    </>
  );
}

function Kpi({ icon: Icon, label, value, tone = 'bg-muted text-muted-foreground', sub }: { icon: React.ComponentType<{ className?: string }>; label: string; value: number | string; tone?: string; sub?: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 shadow-[var(--shadow-card)]">
      <span className={`flex h-9 w-9 items-center justify-center rounded-md ${tone}`}><Icon className="h-5 w-5" /></span>
      <span className="min-w-0">
        <span className="block text-lg font-semibold text-foreground">{value}</span>
        <span className="block truncate text-xs text-muted-foreground">{label}{sub ? ` · ${sub}` : ''}</span>
      </span>
    </div>
  );
}

export function ClientDetailView({ client, onBack }: { client: Client; onBack: () => void }) {
  const [overview, setOverview] = React.useState<{ client: Client & { status: string }; kpis: Record<string, any> } | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [tab, setTab] = React.useState('instances');

  React.useEffect(() => {
    let alive = true;
    setLoading(true); setError('');
    getClientOverview(client.id)
      .then((r) => { if (alive) setOverview(r); })
      .catch((e: Error) => { if (alive) setError(friendlyError(e.message) || 'Falha ao carregar o cliente'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [client.id]);

  const k = overview?.kpis;
  const status = overview?.client.status || client.status;

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 lg:px-8">
      <div className="mb-6 flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label="Voltar para clientes"><ArrowLeft className="h-4 w-4" /></Button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate font-heading text-2xl font-semibold text-foreground">{overview?.client.name || client.name}</h1>
            {status && <StatusBadge tone={status === 'active' ? 'success' : 'warning'}>{status === 'active' ? 'Ativo' : 'Suspenso'}</StatusBadge>}
          </div>
          <p className="text-sm text-muted-foreground">Cliente #{client.id} · detalhes administrativos (somente leitura)</p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : error ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive"><AlertCircle className="h-6 w-6" /></div>
          <p className="max-w-sm text-sm text-muted-foreground">{error}</p>
          <Button variant="outline" size="sm" onClick={onBack}>Voltar</Button>
        </div>
      ) : k ? (
        <>
          {/* KPIs */}
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
            <Kpi icon={Radio} label="Instâncias" value={k.instances.total} sub={`${k.instances.connected} on`} tone="bg-info/10 text-info" />
            <Kpi icon={CheckCircle2} label="Captura mapeada" value={`${k.instances.captureMapped}/${k.instances.total}`} tone="bg-success/10 text-success" />
            <Kpi icon={MessageSquare} label="Conversas" value={k.conversations} tone="bg-muted text-muted-foreground" />
            <Kpi icon={MessagesSquare} label="Grupos" value={k.groups} tone="bg-muted text-muted-foreground" />
            <Kpi icon={UsersIcon} label="Usuários" value={k.users.total} tone="bg-muted text-muted-foreground" />
            <Kpi icon={UsersRound} label="Equipes" value={k.teams} tone="bg-muted text-muted-foreground" />
            <Kpi icon={Contact} label="Contatos identificados" value={`${k.contacts.identified}/${k.contacts.total}`} tone="bg-success/10 text-success" />
            <Kpi icon={Contact} label="Contatos pendentes" value={k.contacts.pending} tone="bg-warning/10 text-warning" />
          </div>

          {/* Abas */}
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="mb-4 flex-wrap">
              <TabsTrigger value="instances">Instâncias</TabsTrigger>
              <TabsTrigger value="conversations">Conversas</TabsTrigger>
              <TabsTrigger value="groups">Grupos</TabsTrigger>
              <TabsTrigger value="users">Usuários</TabsTrigger>
              <TabsTrigger value="teams">Equipes</TabsTrigger>
              <TabsTrigger value="contacts">Contatos</TabsTrigger>
            </TabsList>
            <TabsContent value="instances"><InstancesPanel id={client.id} /></TabsContent>
            <TabsContent value="conversations"><ConversationsView groupMode={false} tenantId={client.id} /></TabsContent>
            <TabsContent value="groups"><ConversationsView groupMode tenantId={client.id} /></TabsContent>
            <TabsContent value="users"><UsersPanel id={client.id} /></TabsContent>
            <TabsContent value="teams"><TeamsPanel id={client.id} /></TabsContent>
            <TabsContent value="contacts"><ContactsPanel id={client.id} /></TabsContent>
          </Tabs>
        </>
      ) : null}
    </main>
  );
}
