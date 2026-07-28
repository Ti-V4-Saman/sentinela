import * as React from 'react';
import { getClient } from '../services/adminApi';
import { createTenantController, type ActiveTenant } from './tenantController';

// Contexto CENTRAL de "cliente ativo" (tenant) para o superadmin (ver docs/CONTEXTO-TENANT.md).
// A lógica de corrida/abort vive no controller PURO (tenantController.ts, testável em node); este
// wrapper faz a ponte com React e sincroniza o estado com a URL (?tenant=<id>).

type TenantCtx = {
  isSuper: boolean;
  activeTenant: ActiveTenant | null;
  isGlobalView: boolean;
  loading: boolean;   // restauração inicial pela URL
  selecting: boolean; // troca manual em andamento
  error: string;
  epoch: number;      // muda a cada troca do cliente ativo — usado para remontar telas
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
  const controllerRef = React.useRef<ReturnType<typeof createTenantController> | null>(null);
  if (!controllerRef.current) controllerRef.current = createTenantController({ getClient, isSuper });
  const controller = controllerRef.current;

  // Primeira renderização já reflete "loading" quando há um ?tenant a validar — assim o efeito de URL
  // NÃO apaga o parâmetro antes da validação inicial concluir.
  const [state, setState] = React.useState(() => ({
    ...controller.getState(),
    loading: isSuper && readTenantParam() != null,
  }));

  React.useEffect(() => {
    const unsub = controller.subscribe(setState);
    controller.init(isSuper ? readTenantParam() : null);
    return () => { unsub(); controller.dispose(); }; // desmontagem cancela requests pendentes
  }, [controller, isSuper]);

  // URL ↔ estado. A URL só reflete o cliente ATIVO (comitado); durante a restauração inicial (loading)
  // não tocamos no parâmetro (para não apagar o ?tenant sendo validado).
  React.useEffect(() => {
    if (state.loading) return;
    writeTenantParam(state.activeTenant?.id ?? null);
  }, [state.activeTenant, state.loading]);

  // epoch: incrementa quando o cliente ativo (comitado) muda.
  const epochRef = React.useRef(0);
  const prevIdRef = React.useRef<number | null>(state.activeTenant?.id ?? null);
  const curId = state.activeTenant?.id ?? null;
  if (curId !== prevIdRef.current) { prevIdRef.current = curId; epochRef.current += 1; }

  const value = React.useMemo<TenantCtx>(() => ({
    isSuper,
    activeTenant: state.activeTenant,
    isGlobalView: isSuper && !state.activeTenant,
    loading: state.loading,
    selecting: state.selecting,
    error: state.error,
    epoch: epochRef.current,
    selectTenant: (id: number) => controller.select(id),
    exitClient: () => controller.exit(),
  }), [isSuper, state, controller]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTenant(): TenantCtx {
  const v = React.useContext(Ctx);
  if (!v) throw new Error('useTenant deve ser usado dentro de <TenantProvider>');
  return v;
}
