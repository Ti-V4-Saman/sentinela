import * as React from 'react';
import { getClient } from '../services/adminApi';

// Contexto CENTRAL de "cliente ativo" (tenant) para o superadmin.
//  - Visão global: activeTenant = null, isGlobalView = true (só superadmin).
//  - Modo cliente: activeTenant = {id,name,status}; todas as telas operacionais atuam nesse tenant.
// Para não-superadmin o contexto é inerte (sem seletor, sem tarja): o backend já os restringe ao
// próprio tenant pelo JWT. O tenant NUNCA é confiado só pelo frontend — selectTenant revalida no
// backend (GET /api/clients/:id), e todo endpoint revalida o acesso a cada requisição.

export type ActiveTenant = { id: number; name: string; status?: string };

type TenantCtx = {
  isSuper: boolean;
  activeTenant: ActiveTenant | null;
  isGlobalView: boolean;
  loading: boolean;
  epoch: number; // muda a cada troca/saída — usado para remontar telas e limpar cache/filtros
  selectTenant: (id: number) => Promise<boolean>;
  exitClient: () => void;
};

const Ctx = React.createContext<TenantCtx | null>(null);

function readTenantParam(): number | null {
  const p = new URLSearchParams(window.location.search).get('tenant');
  const n = p ? Number(p) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}
function writeTenantParam(id: number | null) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set('tenant', String(id));
  else url.searchParams.delete('tenant');
  window.history.replaceState({}, '', url.toString());
}

export function TenantProvider({ isSuper, children }: { isSuper: boolean; children: React.ReactNode }) {
  const [activeTenant, setActiveTenant] = React.useState<ActiveTenant | null>(null);
  const [loading, setLoading] = React.useState(isSuper && readTenantParam() != null);
  const [epoch, setEpoch] = React.useState(0);

  // Restaura o contexto do tenant a partir da URL no carregamento (reload-safe), revalidando no
  // backend. Só superadmin; para os demais, qualquer ?tenant= é ignorado (e removido).
  React.useEffect(() => {
    if (!isSuper) { writeTenantParam(null); setLoading(false); return; }
    const id = readTenantParam();
    if (!id) { setLoading(false); return; }
    let alive = true;
    getClient(id)
      .then((t: ActiveTenant) => { if (alive) setActiveTenant(t); })
      .catch(() => { if (alive) writeTenantParam(null); }) // inválido/inacessível → volta ao global
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [isSuper]);

  const selectTenant = React.useCallback(async (id: number) => {
    try {
      const t = await getClient(id); // revalidação no backend (404 se não puder atuar)
      setActiveTenant(t);
      writeTenantParam(t.id);
      setEpoch((e) => e + 1);
      return true;
    } catch {
      return false;
    }
  }, []);

  const exitClient = React.useCallback(() => {
    setActiveTenant(null);
    writeTenantParam(null);
    setEpoch((e) => e + 1);
  }, []);

  const value = React.useMemo<TenantCtx>(() => ({
    isSuper,
    activeTenant,
    isGlobalView: isSuper && !activeTenant,
    loading,
    epoch,
    selectTenant,
    exitClient,
  }), [isSuper, activeTenant, loading, epoch, selectTenant, exitClient]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTenant(): TenantCtx {
  const v = React.useContext(Ctx);
  if (!v) throw new Error('useTenant deve ser usado dentro de <TenantProvider>');
  return v;
}
