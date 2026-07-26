import * as React from 'react';
import { Radio, Wifi, WifiOff, QrCode, Power, Settings } from 'lucide-react';
import { StatCard } from '@/components/cards';
import { StatusBadge } from '@/components/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';

type Instance = {
  id: string;
  name: string;
  status: string;
  phoneNumber?: string;
  contactName?: string;
  ownerUserId?: number;
  updatedAt?: string;
};

function fmtDate(iso?: string) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export default function ConnectionsView({
  instances,
  counts,
  onConnect,
  onDisconnect,
  onEditToken,
  canManage,
}: {
  instances: Instance[];
  counts: { total: number; connected: number; disconnected: number };
  onConnect: (i: Instance) => void;
  onDisconnect: (i: Instance) => void;
  onEditToken?: (i: Instance) => void;
  canManage: (i: Instance) => boolean;
}) {
  return (
    <div className="space-y-6">
      {/* KPIs */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Total de conexões" value={counts.total} icon={Radio} tone="primary" />
        <StatCard label="Conectadas" value={counts.connected} icon={Wifi} tone="success" />
        <StatCard label="Desconectadas" value={counts.disconnected} icon={WifiOff} tone="destructive" />
      </div>

      {/* Tabela */}
      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-[var(--shadow-card)]">
        {instances.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Radio className="h-6 w-6" />
            </div>
            <h3 className="text-base font-semibold text-foreground">Nenhuma conexão encontrada</h3>
            <p className="max-w-sm text-sm text-muted-foreground">
              Crie uma instância para conectar um número de WhatsApp e começar o monitoramento.
            </p>
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
                    <TableCell className="font-medium text-foreground">
                      {inst.contactName || inst.name}
                    </TableCell>
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
                        <div className="flex items-center justify-end gap-1.5">
                          {connected ? (
                            <Button variant="outline" size="sm" onClick={() => onDisconnect(inst)}>
                              <Power className="h-3.5 w-3.5" /> Sair
                            </Button>
                          ) : (
                            <Button size="sm" onClick={() => onConnect(inst)}>
                              <QrCode className="h-3.5 w-3.5" /> Conectar
                            </Button>
                          )}
                          {onEditToken && (
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label="Editar token"
                              onClick={() => onEditToken(inst)}
                            >
                              <Settings className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
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
    </div>
  );
}
