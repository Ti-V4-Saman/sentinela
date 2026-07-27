import * as React from 'react';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export type TenantOption = { id: number; name: string };

// Intervalo padrão: últimos 30 dias (horário do banco/UI — datas YYYY-MM-DD).
export function defaultRange() {
  const to = new Date();
  const from = new Date(to.getTime() - 29 * 86400000);
  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { from: fmt(from), to: fmt(to) };
}

// Controles compartilhados: período + (superadmin) cliente. `tenants` só é usado quando isSuper.
export function PeriodControls({
  from, to, onFrom, onTo, isSuper, tenantId, onTenant, tenants,
}: {
  from: string; to: string; onFrom: (v: string) => void; onTo: (v: string) => void;
  isSuper?: boolean; tenantId?: string; onTenant?: (v: string) => void; tenants?: TenantOption[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-2">
        <Input type="date" value={from} onChange={(e) => onFrom(e.target.value)} className="w-[150px]" aria-label="Data inicial" />
        <span className="text-xs text-muted-foreground">até</span>
        <Input type="date" value={to} onChange={(e) => onTo(e.target.value)} className="w-[150px]" aria-label="Data final" />
      </div>
      {isSuper && (
        <Select value={tenantId || 'ALL'} onValueChange={(v) => onTenant?.(v)}>
          <SelectTrigger className="w-[190px]" aria-label="Cliente"><SelectValue placeholder="Todos os clientes" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Todos os clientes</SelectItem>
            {(tenants || []).map((t) => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
