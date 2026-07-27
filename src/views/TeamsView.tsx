import * as React from 'react';
import {
  UsersRound, Plus, Pencil, Trash2, MoreHorizontal, Link2, RotateCw,
  AlertCircle, SearchX, ChevronLeft, ChevronRight,
} from 'lucide-react';
import { SearchInput } from '@/components/input-group';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { TeamFormDialog, type TeamRow, type TenantOption } from '@/components/teams/team-form-dialog';
import { TeamLinksDialog } from '@/components/teams/team-links-dialog';
import { listTeams, createTeam, updateTeam, deleteTeam, listTenants } from '../services/adminApi';
import { getUser } from '../services/authApi';
import { useToast } from '../components/ui/ToastProvider';
import { useConfirm } from '../components/ui/ConfirmProvider';
import { friendlyError } from '../utils/validation';

type Team = TeamRow & { tenantId: number; userCount: number; managerCount: number };

const PAGE_SIZE = 10;

export default function TeamsView() {
  const me = getUser();
  const isSuper = me?.role === 'superadmin';
  const toast = useToast();
  const confirm = useConfirm();

  const [teams, setTeams] = React.useState<Team[]>([]);
  const [tenants, setTenants] = React.useState<TenantOption[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [refreshing, setRefreshing] = React.useState(false);

  const [search, setSearch] = React.useState('');
  const [tenantFilter, setTenantFilter] = React.useState('ALL');
  const [page, setPage] = React.useState(1);

  const [formOpen, setFormOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Team | null>(null);
  const [linksTeam, setLinksTeam] = React.useState<Team | null>(null);

  const tenantName = (id: number) => tenants.find((t) => t.id === id)?.name || `#${id}`;

  const load = React.useCallback(async (opts?: { silent?: boolean }) => {
    if (opts?.silent) setRefreshing(true); else setLoading(true);
    setError('');
    try {
      if (isSuper && tenants.length === 0) setTenants(await listTenants());
      setTeams(await listTeams());
    } catch (e) {
      const msg = friendlyError((e as Error).message) || 'Falha ao carregar as equipes';
      if (opts?.silent) toast.error('Não foi possível atualizar', msg); else setError(msg);
    } finally {
      if (opts?.silent) setRefreshing(false); else setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuper]);

  React.useEffect(() => { load(); }, [load]);

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    return teams.filter((t) => {
      const matchesSearch = !q || t.name.toLowerCase().includes(q);
      const matchesTenant = !isSuper || tenantFilter === 'ALL' || String(t.tenantId) === tenantFilter;
      return matchesSearch && matchesTenant;
    });
  }, [teams, search, tenantFilter, isSuper]);

  const filtering = Boolean(search) || (isSuper && tenantFilter !== 'ALL');
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageItems = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  React.useEffect(() => { setPage(1); }, [search, tenantFilter]);

  const openCreate = () => { setEditing(null); setFormOpen(true); };
  const openEdit = (t: Team) => { setEditing(t); setFormOpen(true); };

  const handleSubmit = async (body: { name: string; tenantId?: number }, isEditing: boolean) => {
    if (isEditing) {
      await updateTeam(editing!.id, { name: body.name });
      toast.success('Equipe atualizada', `"${body.name}" foi salva.`);
    } else {
      await createTeam(isSuper ? body : { name: body.name });
      toast.success('Equipe criada', `"${body.name}" foi adicionada.`);
    }
    await load();
  };

  const remove = async (t: Team) => {
    const ok = await confirm({
      title: `Excluir equipe "${t.name}"?`,
      description: 'Esta ação é irreversível.',
      impact: [
        `${t.userCount} membro(s) e ${t.managerCount} gestor(es) NÃO são excluídos — apenas ficam sem equipe.`,
        'As instâncias permanecem (continuam com seus donos).',
      ],
      variant: 'danger',
      confirmLabel: 'Excluir permanentemente',
    });
    if (!ok) return;
    try {
      await deleteTeam(t.id);
      await load();
      toast.success('Equipe excluída', `"${t.name}" foi removida.`);
    } catch (e) {
      toast.error('Não foi possível excluir', friendlyError((e as Error).message));
    }
  };

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 lg:px-8">
      {/* Cabeçalho */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-heading text-2xl font-semibold text-foreground">Equipes</h1>
          <p className="text-sm text-muted-foreground">Agrupam usuários; os números vêm dos usuários vinculados</p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4" /> Nova equipe
        </Button>
      </div>

      {/* Busca + filtro + atualizar */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Pesquisar por nome da equipe..."
          className="flex-1 sm:max-w-sm"
        />
        {isSuper && (
          <Select value={tenantFilter} onValueChange={setTenantFilter}>
            <SelectTrigger className="w-full sm:w-[190px]" aria-label="Filtrar por cliente">
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
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-4 py-4">
                <Skeleton className="h-4 w-44" />
                <Skeleton className="h-4 w-20" />
                <Skeleton className="ml-auto h-8 w-28 rounded-md" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
              {filtering ? <SearchX className="h-6 w-6" /> : <UsersRound className="h-6 w-6" />}
            </div>
            <h3 className="text-base font-semibold text-foreground">
              {filtering ? 'Nenhum resultado' : 'Nenhuma equipe ainda'}
            </h3>
            <p className="max-w-sm text-sm text-muted-foreground">
              {filtering ? 'Nenhuma equipe bate com os filtros atuais.' : 'Crie uma equipe e vincule usuários a ela.'}
            </p>
            {filtering ? (
              <Button variant="outline" size="sm" onClick={() => { setSearch(''); setTenantFilter('ALL'); }}>
                Limpar filtros
              </Button>
            ) : (
              <Button size="sm" onClick={openCreate}><Plus className="h-4 w-4" /> Nova equipe</Button>
            )}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nome</TableHead>
                {isSuper && <TableHead>Cliente</TableHead>}
                <TableHead className="text-center">Membros</TableHead>
                <TableHead className="text-center">Gestores</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageItems.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium text-foreground">{t.name}</TableCell>
                  {isSuper && <TableCell className="text-sm text-muted-foreground">{tenantName(t.tenantId)}</TableCell>}
                  <TableCell className="text-center text-sm text-muted-foreground">{t.userCount}</TableCell>
                  <TableCell className="text-center text-sm text-muted-foreground">{t.managerCount}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Button variant="outline" size="sm" onClick={() => setLinksTeam(t)}>
                        <Link2 className="h-4 w-4" /> Vínculos
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label={`Ações de ${t.name}`}>
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuItem onClick={() => openEdit(t)}>
                            <Pencil className="h-4 w-4" /> Editar
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onClick={() => remove(t)}>
                            <Trash2 className="h-4 w-4" /> Excluir
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Rodapé: contagem + paginação */}
      {!loading && !error && filtered.length > 0 && (
        <div className="mt-3 flex flex-col items-center justify-between gap-3 sm:flex-row">
          <p className="text-xs text-muted-foreground">
            {filtered.length} de {teams.length} equipe(s)
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
        <TeamFormDialog
          initial={editing}
          isSuper={isSuper}
          tenants={tenants}
          onClose={() => setFormOpen(false)}
          onSubmit={handleSubmit}
        />
      )}
      {linksTeam && (
        <TeamLinksDialog
          team={linksTeam}
          isSuper={isSuper}
          toast={toast}
          onClose={() => { setLinksTeam(null); load({ silent: true }); }}
        />
      )}
    </main>
  );
}
