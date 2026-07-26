import * as React from 'react';
import {
  Radio, Wifi, WifiOff, Plus, RotateCw, MoreHorizontal, QrCode, Power, Settings, AlertCircle, SearchX,
} from 'lucide-react';
import { StatCard } from '@/components/cards';
import { StatusBadge } from '@/components/badge';
import { SearchInput } from '@/components/input-group';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

type Instance = {
  id: string; name: string; status: string;
  phoneNumber?: string; contactName?: string; ownerUserId?: number; updatedAt?: string; token?: string;
};

function fmtDate(iso?: string) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export default function ConnectionsView({
  instances, rawCount, counts,
  searchQuery, setSearchQuery, statusFilter, setStatusFilter,
  onConnect, onDisconnect, onEditToken, canManage,
  canCreate, onCreate, onRefresh, isRefreshing,
  loading, error, onRetry,
}: {
  instances: Instance[];
  rawCount: number;
  counts: { total: number; connected: number; disconnected: number };
  searchQuery: string;
  setSearchQuery: (v: string) => void;
  statusFilter: string;
  setStatusFilter: (v: string) => void;
  onConnect: (i: Instance) => void;
  onDisconnect: (i: Instance) => void;
  onEditToken: (i: Instance) => void;
  canManage: (i: Instance) => boolean;
  canCreate: boolean;
  onCreate: () => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  loading: boolean;
  error: string;
  onRetry: () => void;
}) {
  const filtering = Boolean(searchQuery) || statusFilter !== 'ALL';

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 lg:px-8">
      {/* Cabeçalho */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-heading text-2xl font-semibold text-foreground">Gestão de Conexões</h1>
          <p className="text-sm text-muted-foreground">Monitore os números de WhatsApp conectados</p>
        </div>
        {canCreate && (
          <Button onClick={onCreate}>
            <Plus className="h-4 w-4" /> Nova conexão
          </Button>
        )}
      </div>

      {/* KPIs */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Total de conexões" value={counts.total} icon={Radio} tone="primary" />
        <StatCard label="Conectadas" value={counts.connected} icon={Wifi} tone="success" />
        <StatCard label="Desconectadas" value={counts.disconnected} icon={WifiOff} tone="destructive" />
      </div>

      {/* Busca + filtro + atualizar */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="Pesquisar por nome ou número..."
          className="flex-1 sm:max-w-sm"
        />
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full sm:w-[190px]" aria-label="Filtrar por status">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Todos os status</SelectItem>
            <SelectItem value="Connected">Conectadas</SelectItem>
            <SelectItem value="Disconnected">Desconectadas</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" size="icon" onClick={onRefresh} aria-label="Atualizar status">
          <RotateCw className={isRefreshing ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
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
            <Button variant="outline" size="sm" onClick={onRetry}>Tentar novamente</Button>
          </div>
        ) : loading ? (
          <div className="divide-y divide-border">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-4 py-4">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-5 w-24 rounded-full" />
                <Skeleton className="ml-auto h-8 w-8 rounded-md" />
              </div>
            ))}
          </div>
        ) : instances.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
              {filtering ? <SearchX className="h-6 w-6" /> : <Radio className="h-6 w-6" />}
            </div>
            <h3 className="text-base font-semibold text-foreground">
              {filtering ? 'Nenhum resultado' : 'Nenhuma conexão ainda'}
            </h3>
            <p className="max-w-sm text-sm text-muted-foreground">
              {filtering
                ? 'Nenhuma conexão bate com os filtros atuais.'
                : 'Crie uma conexão para começar a monitorar um número de WhatsApp.'}
            </p>
            {filtering ? (
              <Button variant="outline" size="sm" onClick={() => { setSearchQuery(''); setStatusFilter('ALL'); }}>
                Limpar filtros
              </Button>
            ) : canCreate ? (
              <Button size="sm" onClick={onCreate}><Plus className="h-4 w-4" /> Nova conexão</Button>
            ) : null}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nome</TableHead>
                <TableHead>Número</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Atualizado</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {instances.map((inst) => {
                const connected = inst.status === 'Connected';
                const manage = canManage(inst);
                return (
                  <TableRow key={inst.id}>
                    <TableCell className="font-medium text-foreground">{inst.contactName || inst.name}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {inst.phoneNumber ? inst.phoneNumber.split(':')[0] : '—'}
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={connected ? 'success' : 'destructive'}>
                        {connected ? 'Conectada' : 'Desconectada'}
                      </StatusBadge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{fmtDate(inst.updatedAt)}</TableCell>
                    <TableCell className="text-right">
                      {manage ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" aria-label={`Ações de ${inst.name}`}>
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-44">
                            {connected ? (
                              <DropdownMenuItem onClick={() => onDisconnect(inst)}>
                                <Power className="h-4 w-4" /> Desconectar
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem onClick={() => onConnect(inst)}>
                                <QrCode className="h-4 w-4" /> Conectar
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem onClick={() => onEditToken(inst)}>
                              <Settings className="h-4 w-4" /> Editar token
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {rawCount > 0 && !loading && !error && (
        <p className="mt-3 text-xs text-muted-foreground">
          {instances.length} de {rawCount} conexão(ões)
        </p>
      )}
    </main>
  );
}
