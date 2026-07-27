import * as React from 'react';
import {
  Building2, Plus, Pencil, Trash2, PauseCircle, PlayCircle, MoreHorizontal,
  RotateCw, AlertCircle, SearchX, ChevronLeft, ChevronRight, Eye,
} from 'lucide-react';
import { StatusBadge } from '@/components/badge';
import { SearchInput } from '@/components/input-group';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ClientFormDialog } from '@/components/clients/client-form-dialog';
import { ClientDetailView } from './ClientDetailView';
import { listTenants, createTenant, updateTenant, deleteTenant, listUsers, listTeams } from '../services/adminApi';
import { fetchInstancesApi } from '../services/quepasaApi';
import { useToast } from '../components/ui/ToastProvider';
import { useConfirm } from '../components/ui/ConfirmProvider';
import { friendlyError } from '../utils/validation';

type Tenant = { id: number; name: string; status: string };

const PAGE_SIZE = 10;

export default function ClientsView() {
  const toast = useToast();
  const confirm = useConfirm();

  const [tenants, setTenants] = React.useState<Tenant[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [refreshing, setRefreshing] = React.useState(false);

  const [search, setSearch] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState('ALL');
  const [page, setPage] = React.useState(1);

  const [formOpen, setFormOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Tenant | null>(null);
  const [detail, setDetail] = React.useState<Tenant | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true); setError('');
    try {
      setTenants(await listTenants());
    } catch (e) {
      setError(friendlyError((e as Error).message) || 'Falha ao carregar os clientes');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    try { setTenants(await listTenants()); setError(''); }
    catch (e) { toast.error('Não foi possível atualizar', friendlyError((e as Error).message)); }
    finally { setRefreshing(false); }
  };

  // Busca (nome / #id) + filtro de status.
  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    return tenants.filter((t) => {
      const matchesSearch = !q
        || t.name.toLowerCase().includes(q)
        || String(t.id).includes(q.replace('#', ''));
      const matchesStatus = statusFilter === 'ALL' || t.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [tenants, search, statusFilter]);

  const filtering = Boolean(search) || statusFilter !== 'ALL';
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageItems = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  // Reseta a página quando os filtros mudam.
  React.useEffect(() => { setPage(1); }, [search, statusFilter]);

  const openCreate = () => { setEditing(null); setFormOpen(true); };
  const openEdit = (t: Tenant) => { setEditing(t); setFormOpen(true); };

  if (detail) return <ClientDetailView client={detail} onBack={() => setDetail(null)} />;

  const handleSubmit = async (values: { name: string; status?: string }, isEditing: boolean) => {
    const saved = isEditing
      ? await updateTenant(editing!.id, { name: values.name, status: values.status })
      : await createTenant({ name: values.name });
    await load();
    toast.success(
      isEditing ? 'Cliente atualizado' : 'Cliente criado',
      `"${saved.name}" foi ${isEditing ? 'salvo' : 'adicionado'} com sucesso.`,
    );
  };

  const toggleStatus = async (t: Tenant) => {
    if (t.status === 'active') {
      const ok = await confirm({
        title: `Suspender o cliente "${t.name}"?`,
        description: 'Ação reversível — você pode reativar depois.',
        impact: ['Usuários deste cliente não conseguem mais fazer login enquanto estiver suspenso.'],
        variant: 'warning',
        confirmLabel: 'Suspender',
      });
      if (!ok) return;
    }
    try {
      await updateTenant(t.id, { status: t.status === 'active' ? 'suspended' : 'active' });
      await load();
      toast.success(t.status === 'active' ? 'Cliente suspenso' : 'Cliente reativado', `"${t.name}" foi atualizado.`);
    } catch (e) {
      toast.error('Não foi possível alterar', friendlyError((e as Error).message));
    }
  };

  const remove = async (t: Tenant) => {
    // Levanta o impacto em cascata (usuários, equipes, instâncias vinculadas).
    let users = 0, teams = 0, instances = 0;
    try {
      const [u, tm, inst] = await Promise.all([listUsers(t.id), listTeams(t.id), fetchInstancesApi()]);
      users = u.length; teams = tm.length;
      instances = inst.filter((i: { tenantId: number | string }) => Number(i.tenantId) === Number(t.id)).length;
    } catch { /* segue mesmo sem os counts */ }

    const impact = [
      `${users} usuário(s) vinculado(s) serão excluídos.`,
      `${teams} equipe(s) serão excluídas.`,
      instances > 0
        ? `${instances} instância(s) vinculada(s) IMPEDEM a exclusão — remova-as antes.`
        : 'Nenhuma instância vinculada.',
      'Todo o histórico de mensagens associado será perdido.',
    ];

    const ok = await confirm({
      title: `Excluir cliente "${t.name}"?`,
      description: 'Esta é a ação mais destrutiva do sistema e é irreversível.',
      impact,
      variant: 'danger',
      requireTypedName: t.name,
      confirmLabel: 'Excluir permanentemente',
    });
    if (!ok) return;
    try {
      await deleteTenant(t.id);
      await load();
      toast.success('Cliente excluído', `"${t.name}" foi removido.`);
    } catch (e) {
      toast.error('Não foi possível excluir', friendlyError((e as Error).message));
    }
  };

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 lg:px-8">
      {/* Cabeçalho */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-heading text-2xl font-semibold text-foreground">Clientes</h1>
          <p className="text-sm text-muted-foreground">Clientes isolados do sistema (multi-tenant)</p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4" /> Novo cliente
        </Button>
      </div>

      {/* Busca + filtro + atualizar */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Pesquisar por nome ou #id..."
          className="flex-1 sm:max-w-sm"
        />
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full sm:w-[190px]" aria-label="Filtrar por status">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Todos os status</SelectItem>
            <SelectItem value="active">Ativos</SelectItem>
            <SelectItem value="suspended">Suspensos</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" size="icon" onClick={refresh} aria-label="Atualizar lista">
          <RotateCw className={refreshing ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
        </Button>
      </div>

      {/* Conteúdo: erro | loading | vazio | tabela */}
      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-[var(--shadow-card)]">
        {error ? (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <AlertCircle className="h-6 w-6" />
            </div>
            <h3 className="text-base font-semibold text-foreground">Não foi possível carregar</h3>
            <p className="max-w-sm text-sm text-muted-foreground">{error}</p>
            <Button variant="outline" size="sm" onClick={load}>Tentar novamente</Button>
          </div>
        ) : loading ? (
          <div className="divide-y divide-border">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-4 py-4">
                <Skeleton className="h-4 w-10" />
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-5 w-20 rounded-full" />
                <Skeleton className="ml-auto h-8 w-8 rounded-md" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
              {filtering ? <SearchX className="h-6 w-6" /> : <Building2 className="h-6 w-6" />}
            </div>
            <h3 className="text-base font-semibold text-foreground">
              {filtering ? 'Nenhum resultado' : 'Nenhum cliente ainda'}
            </h3>
            <p className="max-w-sm text-sm text-muted-foreground">
              {filtering
                ? 'Nenhum cliente bate com os filtros atuais.'
                : 'Crie o primeiro cliente para isolar dados no sistema.'}
            </p>
            {filtering ? (
              <Button variant="outline" size="sm" onClick={() => { setSearch(''); setStatusFilter('ALL'); }}>
                Limpar filtros
              </Button>
            ) : (
              <Button size="sm" onClick={openCreate}><Plus className="h-4 w-4" /> Novo cliente</Button>
            )}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-20">ID</TableHead>
                <TableHead>Nome</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageItems.map((t) => {
                const active = t.status === 'active';
                return (
                  <TableRow key={t.id}>
                    <TableCell className="font-mono text-xs text-muted-foreground">#{t.id}</TableCell>
                    <TableCell className="font-medium text-foreground">
                      <button className="text-left hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50" onClick={() => setDetail(t)}>
                        {t.name}
                      </button>
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={active ? 'success' : 'warning'}>
                        {active ? 'Ativo' : 'Suspenso'}
                      </StatusBadge>
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label={`Ações de ${t.name}`}>
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-48">
                          <DropdownMenuItem onClick={() => setDetail(t)}>
                            <Eye className="h-4 w-4" /> Ver detalhes
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => openEdit(t)}>
                            <Pencil className="h-4 w-4" /> Editar
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => toggleStatus(t)}>
                            {active
                              ? <><PauseCircle className="h-4 w-4" /> Suspender</>
                              : <><PlayCircle className="h-4 w-4" /> Reativar</>}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onClick={() => remove(t)}>
                            <Trash2 className="h-4 w-4" /> Excluir
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Rodapé: contagem + paginação */}
      {!loading && !error && filtered.length > 0 && (
        <div className="mt-3 flex flex-col items-center justify-between gap-3 sm:flex-row">
          <p className="text-xs text-muted-foreground">
            {filtered.length} de {tenants.length} cliente(s)
          </p>
          {totalPages > 1 && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline" size="icon" aria-label="Página anterior"
                disabled={currentPage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-xs text-muted-foreground">Página {currentPage} de {totalPages}</span>
              <Button
                variant="outline" size="icon" aria-label="Próxima página"
                disabled={currentPage >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      )}

      {formOpen && (
        <ClientFormDialog
          initial={editing}
          onClose={() => setFormOpen(false)}
          onSubmit={handleSubmit}
        />
      )}
    </main>
  );
}
