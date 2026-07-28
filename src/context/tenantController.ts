// Controller PURO do contexto de tenant (sem React/DOM) — testável isoladamente em node.
//
// Garante que somente a seleção MAIS RECENTE atualize o estado, resolvendo a corrida em que duas
// trocas concorrentes chegam fora de ordem. Estratégia combinada:
//  - contador sequencial (`seq`): cada operação recebe um token; um resultado só é aplicado se seu
//    token ainda é o mais recente (`token === seq`);
//  - AbortController: a requisição anterior é abortada ao iniciar uma nova seleção, ao sair do modo
//    cliente e ao descartar (dispose/unmount).
//
// O estado (`activeTenant`) é a única fonte da verdade — o wrapper React espelha isso na URL, de modo
// que URL e estado nunca divergem: a URL só muda quando `activeTenant` muda (após validação/saída).

export type ActiveTenant = { id: number; name: string; status?: string };
export type TenantState = { activeTenant: ActiveTenant | null; loading: boolean; selecting: boolean; error: string };

type GetClient = (id: number, signal?: AbortSignal) => Promise<ActiveTenant>;

const AbortCtor: typeof AbortController | undefined =
  typeof AbortController !== 'undefined' ? AbortController : undefined;

export function createTenantController({ getClient, isSuper }: { getClient: GetClient; isSuper: boolean }) {
  let seq = 0;
  let abort: AbortController | null = null;
  let state: TenantState = { activeTenant: null, loading: false, selecting: false, error: '' };
  const listeners = new Set<(s: TenantState) => void>();

  const set = (patch: Partial<TenantState>) => { state = { ...state, ...patch }; listeners.forEach((fn) => fn(state)); };

  function beginRequest() {
    const token = ++seq;
    if (abort) abort.abort();
    abort = AbortCtor ? new AbortCtor() : null;
    return { token, signal: abort ? abort.signal : undefined };
  }

  async function run(id: number, initial: boolean) {
    const { token, signal } = beginRequest();
    set(initial ? { loading: true, error: '' } : { selecting: true, error: '' });
    try {
      const t = await getClient(id, signal);
      if (token !== seq) return false; // superseda por seleção/saída mais recente
      set({ activeTenant: t, loading: false, selecting: false, error: '' });
      return true;
    } catch (e) {
      if (token !== seq || (signal && signal.aborted)) return false; // abortada/obsoleta → ignora
      set({ loading: false, selecting: false, error: initial ? '' : 'Não foi possível abrir o cliente.' });
      return false;
    }
  }

  return {
    getState: (): TenantState => state,
    subscribe(fn: (s: TenantState) => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },

    // Restauração inicial a partir da URL (só superadmin). Não confia no frontend: valida no backend.
    init(idFromUrl: number | null): Promise<boolean> {
      if (!isSuper || idFromUrl == null) { set({ loading: false }); return Promise.resolve(false); }
      set({ loading: true });
      return run(idFromUrl, true);
    },

    // Seleção manual de cliente. A anterior é abortada/invalidada — a última prevalece.
    select(id: number): Promise<boolean> { return run(id, false); },

    // Saída do modo cliente: invalida qualquer seleção pendente e volta ao global imediatamente.
    exit() {
      seq += 1;                 // invalida requests em andamento (token deixa de ser o atual)
      if (abort) { abort.abort(); abort = null; }
      set({ activeTenant: null, loading: false, selecting: false, error: '' });
    },

    // Desmontagem: cancela qualquer request pendente.
    dispose() {
      seq += 1;
      if (abort) { abort.abort(); abort = null; }
      listeners.clear();
    },
  };
}

export type TenantController = ReturnType<typeof createTenantController>;
