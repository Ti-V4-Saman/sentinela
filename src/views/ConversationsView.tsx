import * as React from 'react';
import {
  MessageSquare, Users as UsersIcon, RotateCw, AlertCircle, SearchX, ChevronLeft, ChevronRight, ArrowRight,
} from 'lucide-react';
import { SearchInput } from '@/components/input-group';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { typeMeta } from '@/components/message';
import { ContactTypeBadge } from '@/components/contacts/contact-type-badge';
import { ChatThreadView } from './ChatThreadView';
import { listChats } from '../services/chatsApi';
import { listInstances, listTeams, listUsers } from '../services/adminApi';
import { getUser } from '../services/authApi';
import { friendlyError } from '../utils/validation';

const PAGE_SIZE = 20;
const MSG_TYPES = ['text', 'audio', 'image', 'video', 'document'];

type Chat = {
  id: string; ref: string; title: string | null; isGroup: boolean;
  contact: {
    id: string | null; name: string | null; phone: string | null;
    displayName?: string | null; identified?: boolean;
    type?: { id: number; name: string; color?: string | null } | null;
  };
  instance: { id: string | null; name: string | null };
  lastMessage: { text: string | null; type: string | null; direction: string; at: string | null };
  messageCount: number; lastActivityAt: string | null;
};

function useDebounced<T>(value: T, delay = 350) {
  const [v, setV] = React.useState(value);
  React.useEffect(() => { const t = setTimeout(() => setV(value), delay); return () => clearTimeout(t); }, [value, delay]);
  return v;
}

function fmtDate(iso?: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export default function ConversationsView({ groupMode }: { groupMode: boolean }) {
  const me = getUser();
  const canFilterOrg = me?.role === 'superadmin' || me?.role === 'admin';

  const [selected, setSelected] = React.useState<Chat | null>(null);

  const [chats, setChats] = React.useState<Chat[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [reloadKey, setReloadKey] = React.useState(0); // dispara nova requisição no retry

  // Filtros
  const [search, setSearch] = React.useState('');
  const [keyword, setKeyword] = React.useState('');
  const [type, setType] = React.useState('ALL');
  const [identified, setIdentified] = React.useState('ALL');
  const [instanceId, setInstanceId] = React.useState('ALL');
  const [teamId, setTeamId] = React.useState('ALL');
  const [userId, setUserId] = React.useState('ALL');
  const [dateFrom, setDateFrom] = React.useState('');
  const [dateTo, setDateTo] = React.useState('');
  const dSearch = useDebounced(search);
  const dKeyword = useDebounced(keyword);

  // Opções de filtro
  const [instances, setInstances] = React.useState<{ id: string; name: string }[]>([]);
  const [teams, setTeams] = React.useState<{ id: number; name: string }[]>([]);
  const [users, setUsers] = React.useState<{ id: number; name: string; role: string }[]>([]);

  React.useEffect(() => {
    listInstances().then((r: { id: string; name: string }[]) => setInstances(r)).catch(() => {});
    if (canFilterOrg) {
      listTeams().then(setTeams).catch(() => {});
      listUsers().then((u: { id: number; name: string; role: string }[]) => setUsers(u.filter((x) => x.role === 'usuario'))).catch(() => {});
    }
  }, [canFilterOrg]);

  const params = React.useMemo(() => ({
    is_group: groupMode ? 1 : 0,
    page, limit: PAGE_SIZE,
    search: dSearch || undefined,
    keyword: dKeyword || undefined,
    type: type !== 'ALL' ? type : undefined,
    identified: identified !== 'ALL' ? identified : undefined,
    instance_id: instanceId !== 'ALL' ? instanceId : undefined,
    team_id: teamId !== 'ALL' ? teamId : undefined,
    user_id: userId !== 'ALL' ? userId : undefined,
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
  }), [groupMode, page, dSearch, dKeyword, type, identified, instanceId, teamId, userId, dateFrom, dateTo]);

  // Reset de página quando um filtro muda.
  React.useEffect(() => { setPage(1); }, [groupMode, dSearch, dKeyword, type, identified, instanceId, teamId, userId, dateFrom, dateTo]);

  // Busca com cancelamento (troca de filtro/aba cancela a requisição anterior).
  React.useEffect(() => {
    const ac = new AbortController();
    setLoading(true); setError('');
    listChats(params, ac.signal)
      .then((r: { total: number; chats: Chat[] }) => { setChats(r.chats); setTotal(r.total); })
      .catch((e: Error) => { if (e.name !== 'AbortError') setError(friendlyError(e.message) || 'Falha ao carregar as conversas'); })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [params, reloadKey]);

  if (selected) return <ChatThreadView chat={selected} onBack={() => setSelected(null)} />;

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtering = Boolean(dSearch || dKeyword || type !== 'ALL' || identified !== 'ALL' || instanceId !== 'ALL' || teamId !== 'ALL' || userId !== 'ALL' || dateFrom || dateTo);
  const clearFilters = () => { setSearch(''); setKeyword(''); setType('ALL'); setIdentified('ALL'); setInstanceId('ALL'); setTeamId('ALL'); setUserId('ALL'); setDateFrom(''); setDateTo(''); };

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 lg:px-8">
      <div className="mb-6">
        <h1 className="font-heading text-2xl font-semibold text-foreground">{groupMode ? 'Grupos' : 'Conversas'}</h1>
        <p className="text-sm text-muted-foreground">
          {groupMode ? 'Conversas em grupo capturadas' : 'Conversas individuais capturadas'} · somente leitura
        </p>
      </div>

      {/* Filtros (aplicados no backend) */}
      <div className="mb-4 flex flex-col gap-3">
        <div className="flex flex-col gap-3 lg:flex-row">
          <SearchInput value={search} onChange={setSearch} placeholder="Buscar por nome ou telefone do contato…" className="flex-1" />
          <SearchInput value={keyword} onChange={setKeyword} placeholder="Palavra-chave nas mensagens…" className="flex-1" />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Select value={type} onValueChange={setType}>
            <SelectTrigger className="w-full sm:w-[160px]" aria-label="Tipo da última mensagem"><SelectValue placeholder="Tipo" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">Todos os tipos</SelectItem>
              {MSG_TYPES.map((t) => <SelectItem key={t} value={t}>{typeMeta(t).label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={identified} onValueChange={setIdentified}>
            <SelectTrigger className="w-full sm:w-[180px]" aria-label="Identificação do contato"><SelectValue placeholder="Identificação" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">Todos os contatos</SelectItem>
              <SelectItem value="1">Identificados</SelectItem>
              <SelectItem value="0">Não identificados</SelectItem>
            </SelectContent>
          </Select>
          <Select value={instanceId} onValueChange={setInstanceId}>
            <SelectTrigger className="w-full sm:w-[190px]" aria-label="Instância"><SelectValue placeholder="Instância" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">Todas as instâncias</SelectItem>
              {instances.map((i) => <SelectItem key={i.id} value={i.id}>{i.name}</SelectItem>)}
            </SelectContent>
          </Select>
          {canFilterOrg && (
            <>
              <Select value={teamId} onValueChange={setTeamId}>
                <SelectTrigger className="w-full sm:w-[170px]" aria-label="Equipe"><SelectValue placeholder="Equipe" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">Todas as equipes</SelectItem>
                  {teams.map((t) => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={userId} onValueChange={setUserId}>
                <SelectTrigger className="w-full sm:w-[170px]" aria-label="Usuário"><SelectValue placeholder="Usuário" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">Todos os usuários</SelectItem>
                  {users.map((u) => <SelectItem key={u.id} value={String(u.id)}>{u.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </>
          )}
          <div className="flex items-center gap-2">
            <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="w-[150px]" aria-label="Data inicial" />
            <span className="text-xs text-muted-foreground">até</span>
            <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="w-[150px]" aria-label="Data final" />
          </div>
          {filtering && <Button variant="ghost" size="sm" onClick={clearFilters}>Limpar filtros</Button>}
        </div>
      </div>

      {/* Conteúdo */}
      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-[var(--shadow-card)]">
        {error ? (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive"><AlertCircle className="h-6 w-6" /></div>
            <h3 className="text-base font-semibold text-foreground">Não foi possível carregar</h3>
            <p className="max-w-sm text-sm text-muted-foreground">{error}</p>
            <Button variant="outline" size="sm" onClick={() => setReloadKey((k) => k + 1)}>Tentar novamente</Button>
          </div>
        ) : loading ? (
          <div className="divide-y divide-border">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-4 py-4">
                <Skeleton className="h-4 w-40" /><Skeleton className="h-4 w-28" /><Skeleton className="ml-auto h-4 w-24" />
              </div>
            ))}
          </div>
        ) : chats.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
              {filtering ? <SearchX className="h-6 w-6" /> : (groupMode ? <UsersIcon className="h-6 w-6" /> : <MessageSquare className="h-6 w-6" />)}
            </div>
            <h3 className="text-base font-semibold text-foreground">{filtering ? 'Nenhum resultado' : 'Nenhuma conversa'}</h3>
            <p className="max-w-sm text-sm text-muted-foreground">
              {filtering ? 'Nenhuma conversa bate com os filtros.' : 'Sem conversas visíveis — verifique os vínculos de instância e a ponte de captura.'}
            </p>
            {filtering && <Button variant="outline" size="sm" onClick={clearFilters}>Limpar filtros</Button>}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{groupMode ? 'Grupo' : 'Contato'}</TableHead>
                <TableHead>Telefone</TableHead>
                <TableHead>Instância</TableHead>
                <TableHead>Última mensagem</TableHead>
                <TableHead>Atividade</TableHead>
                <TableHead className="text-center">Msgs</TableHead>
                <TableHead className="text-right">Ação</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {chats.map((c) => {
                const meta = typeMeta(c.lastMessage.type || undefined);
                const Icon = meta.icon;
                const name = c.title || c.contact.name || c.contact.phone || (c.isGroup ? 'Grupo' : 'Contato');
                return (
                  <TableRow key={c.ref} className="cursor-pointer" onClick={() => setSelected(c)}>
                    <TableCell className="font-medium text-foreground">
                      <span className="inline-flex items-center gap-2">
                        {c.isGroup ? <UsersIcon className="h-3.5 w-3.5 text-muted-foreground" /> : <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />}
                        {name}
                        {!c.isGroup && c.contact.type && <ContactTypeBadge type={c.contact.type} />}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{c.contact.phone || '—'}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{c.instance.name || '—'}</TableCell>
                    <TableCell className="max-w-[280px]">
                      <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                        <Icon className="h-3.5 w-3.5 shrink-0" title={meta.label} />
                        <span className="truncate">{(c.lastMessage.text || meta.label)}</span>
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{fmtDate(c.lastActivityAt)}</TableCell>
                    <TableCell className="text-center text-sm text-muted-foreground">{c.messageCount}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); setSelected(c); }} aria-label={`Abrir conversa ${name}`}>
                        Abrir <ArrowRight className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {!loading && !error && total > 0 && (
        <div className="mt-3 flex flex-col items-center justify-between gap-3 sm:flex-row">
          <p className="text-xs text-muted-foreground">{chats.length} de {total} conversa(s)</p>
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
