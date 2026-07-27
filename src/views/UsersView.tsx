import * as React from 'react';
import {
  Users, Plus, Pencil, Trash2, Radio, MoreHorizontal, RotateCw, AlertCircle, SearchX, ChevronLeft, ChevronRight,
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
import { UserFormDialog, ROLE_LABELS, type UserRow, type TenantOption } from '@/components/users/user-form-dialog';
import { UserInstancesDialog } from '@/components/users/user-instances-dialog';
import { listUsers, createUser, updateUser, deleteUser, listTenants } from '../services/adminApi';
import { getUser } from '../services/authApi';
import { useToast } from '../components/ui/ToastProvider';
import { useConfirm } from '../components/ui/ConfirmProvider';
import { friendlyError } from '../utils/validation';

const PAGE_SIZE = 10;

export default function UsersView({ tenantId: locked }: { tenantId?: number }) {
  const me = getUser();
  // Modo cliente (locked): lista escopada, filtro de cliente oculto, criação no cliente ativo.
  const isSuper = me?.role === 'superadmin' && locked == null;
  const toast = useToast();
  const confirm = useConfirm();

  const [users, setUsers] = React.useState<UserRow[]>([]);
  const [tenants, setTenants] = React.useState<TenantOption[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [refreshing, setRefreshing] = React.useState(false);

  const [search, setSearch] = React.useState('');
  const [roleFilter, setRoleFilter] = React.useState('ALL');
  const [statusFilter, setStatusFilter] = React.useState('ALL');
  const [tenantFilter, setTenantFilter] = React.useState('ALL');
  const [page, setPage] = React.useState(1);

  const [formOpen, setFormOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<UserRow | null>(null);
  const [instancesUser, setInstancesUser] = React.useState<UserRow | null>(null);

  const tenantName = (id?: number | null) =>
    (id != null && tenants.find((t) => t.id === id)?.name) || (id != null ? `#${id}` : '—');

  const load = React.useCallback(async (opts?: { silent?: boolean }) => {
    if (opts?.silent) setRefreshing(true); else setLoading(true);
    setError('');
    try {
      if (isSuper && tenants.length === 0) setTenants(await listTenants());
      const tf = locked != null ? locked : (isSuper && tenantFilter !== 'ALL' ? tenantFilter : undefined);
      setUsers(await listUsers(tf));
    } catch (e) {
      const msg = friendlyError((e as Error).message) || 'Falha ao carregar os usuários';
      if (opts?.silent) toast.error('Não foi possível atualizar', msg); else setError(msg);
    } finally {
      if (opts?.silent) setRefreshing(false); else setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuper, tenantFilter, locked]);

  React.useEffect(() => { load(); }, [load]);

  // Busca (nome/e-mail) + filtros de papel/status (tenant é filtrado no servidor).
  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    return users.filter((u) => {
      const matchesSearch = !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
      const matchesRole = roleFilter === 'ALL' || u.role === roleFilter;
      const matchesStatus = statusFilter === 'ALL' || u.status === statusFilter;
      return matchesSearch && matchesRole && matchesStatus;
    });
  }, [users, search, roleFilter, statusFilter]);

  const filtering = Boolean(search) || roleFilter !== 'ALL' || statusFilter !== 'ALL' || (isSuper && tenantFilter !== 'ALL');
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageItems = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  React.useEffect(() => { setPage(1); }, [search, roleFilter, statusFilter, tenantFilter]);

  const openCreate = () => { setEditing(null); setFormOpen(true); };
  const openEdit = (u: UserRow) => { setEditing(u); setFormOpen(true); };

  const handleSubmit = async (body: Record<string, unknown>, isEditing: boolean) => {
    if (isEditing) {
      await updateUser(editing!.id, body);
      toast.success('Usuário atualizado', `"${body.name}" foi salvo.`);
    } else {
      // No modo cliente, o superadmin cria no cliente ATIVO (injeta o tenant_id).
      await createUser(locked != null ? { ...body, tenantId: locked } : body);
      toast.success('Usuário criado', `"${body.name}" foi adicionado com sucesso.`);
    }
    await load();
  };

  const remove = async (u: UserRow) => {
    const ok = await confirm({
      title: `Excluir usuário "${u.name}"?`,
      description: 'Esta ação é irreversível.',
      impact: [
        `Papel atual: ${ROLE_LABELS[u.role]}.`,
        u.role === 'gestor' ? 'Os vínculos deste gestor com equipes serão removidos.' : 'Sem vínculos de equipe como gestor.',
        'Se o usuário for dono de alguma conexão, a exclusão é bloqueada — desative-o.',
      ],
      variant: 'danger',
      confirmLabel: 'Excluir permanentemente',
    });
    if (!ok) return;
    try {
      await deleteUser(u.id);
      await load();
      toast.success('Usuário excluído', `"${u.name}" foi removido.`);
    } catch (e) {
      toast.error('Não foi possível excluir', friendlyError((e as Error).message));
    }
  };

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 lg:px-8">
      {/* Cabeçalho */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-heading text-2xl font-semibold text-foreground">Usuários</h1>
          <p className="text-sm text-muted-foreground">{isSuper ? 'Todos os clientes' : 'Do seu cliente'}</p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4" /> Novo usuário
        </Button>
      </div>

      {/* Busca + filtros + atualizar */}
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Pesquisar por nome ou e-mail..."
          className="flex-1 lg:max-w-xs"
        />
        <div className="flex flex-wrap items-center gap-3">
          <Select value={roleFilter} onValueChange={setRoleFilter}>
            <SelectTrigger className="w-full sm:w-[170px]" aria-label="Filtrar por papel">
              <SelectValue placeholder="Papel" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">Todos os papéis</SelectItem>
              <SelectItem value="superadmin">Superadmin</SelectItem>
              <SelectItem value="admin">Administrador</SelectItem>
              <SelectItem value="gestor">Gestor</SelectItem>
              <SelectItem value="usuario">Usuário</SelectItem>
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full sm:w-[160px]" aria-label="Filtrar por status">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">Todos os status</SelectItem>
              <SelectItem value="active">Ativos</SelectItem>
              <SelectItem value="disabled">Desativados</SelectItem>
            </SelectContent>
          </Select>
          {isSuper && (
            <Select value={tenantFilter} onValueChange={setTenantFilter}>
              <SelectTrigger className="w-full sm:w-[180px]" aria-label="Filtrar por cliente">
                <SelectValue placeholder="Cliente" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Todos os clientes</SelectItem>
                {tenants.map((t) => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
          <Button variant="outline" size="icon" onClick={() => load({ silent: true })} aria-label="Atualizar lista">
            <RotateCw className={refreshing ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          </Button>
        </div>
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
            <Button variant="outline" size="sm" onClick={() => load()}>Tentar novamente</Button>
          </div>
        ) : loading ? (
          <div className="divide-y divide-border">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-4 py-4">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-52" />
                <Skeleton className="h-5 w-24 rounded-full" />
                <Skeleton className="ml-auto h-8 w-8 rounded-md" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
              {filtering ? <SearchX className="h-6 w-6" /> : <Users className="h-6 w-6" />}
            </div>
            <h3 className="text-base font-semibold text-foreground">
              {filtering ? 'Nenhum resultado' : 'Nenhum usuário ainda'}
            </h3>
            <p className="max-w-sm text-sm text-muted-foreground">
              {filtering
                ? 'Nenhum usuário bate com os filtros atuais.'
                : `Crie o primeiro usuário${isSuper ? '' : ' do seu cliente'}.`}
            </p>
            {filtering ? (
              <Button variant="outline" size="sm" onClick={() => { setSearch(''); setRoleFilter('ALL'); setStatusFilter('ALL'); setTenantFilter('ALL'); }}>
                Limpar filtros
              </Button>
            ) : (
              <Button size="sm" onClick={openCreate}><Plus className="h-4 w-4" /> Novo usuário</Button>
            )}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nome</TableHead>
                <TableHead>E-mail</TableHead>
                <TableHead>Papel</TableHead>
                {isSuper && <TableHead>Cliente</TableHead>}
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageItems.map((u) => {
                const active = u.status === 'active';
                const isSelf = u.id === me?.id;
                return (
                  <TableRow key={u.id}>
                    <TableCell className="font-medium text-foreground">{u.name}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{u.email}</TableCell>
                    <TableCell><StatusBadge tone="neutral">{ROLE_LABELS[u.role]}</StatusBadge></TableCell>
                    {isSuper && <TableCell className="text-sm text-muted-foreground">{tenantName(u.tenantId)}</TableCell>}
                    <TableCell>
                      <StatusBadge tone={active ? 'success' : 'neutral'} dot>
                        {active ? 'Ativo' : 'Desativado'}
                      </StatusBadge>
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label={`Ações de ${u.name}`}>
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuItem onClick={() => openEdit(u)}>
                            <Pencil className="h-4 w-4" /> Editar
                          </DropdownMenuItem>
                          {u.role === 'usuario' && (
                            <DropdownMenuItem onClick={() => setInstancesUser(u)}>
                              <Radio className="h-4 w-4" /> Instâncias
                            </DropdownMenuItem>
                          )}
                          {!isSelf && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem variant="destructive" onClick={() => remove(u)}>
                                <Trash2 className="h-4 w-4" /> Excluir
                              </DropdownMenuItem>
                            </>
                          )}
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
            {filtered.length} de {users.length} usuário(s)
          </p>
          {totalPages > 1 && (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="icon" aria-label="Página anterior"
                disabled={currentPage <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-xs text-muted-foreground">Página {currentPage} de {totalPages}</span>
              <Button variant="outline" size="icon" aria-label="Próxima página"
                disabled={currentPage >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      )}

      {formOpen && (
        <UserFormDialog
          initial={editing}
          isSuper={isSuper}
          tenants={tenants}
          defaultTenantId={isSuper ? '' : (locked != null ? locked : me?.tenantId)}
          confirm={confirm}
          onClose={() => setFormOpen(false)}
          onSubmit={handleSubmit}
        />
      )}
      {instancesUser && (
        <UserInstancesDialog
          user={{ id: instancesUser.id, name: instancesUser.name, tenantId: Number(instancesUser.tenantId ?? me?.tenantId) }}
          toast={toast}
          onClose={() => setInstancesUser(null)}
        />
      )}
    </main>
  );
}
