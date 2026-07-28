import { describe, it, expect } from 'vitest';
import { createTenantController } from '../src/context/tenantController.ts';

// getClient simulado: resolve/rejeita sob controle do teste, guardando o AbortSignal de cada chamada.
function makeGetClient() {
  const calls = [];
  const fn = (id, signal) => new Promise((resolve, reject) => { calls.push({ id, resolve, reject, signal, done: false }); });
  const find = (id) => [...calls].reverse().find((x) => x.id === id && !x.done);
  return {
    fn,
    calls,
    resolve(id, value) { const p = find(id); p.done = true; p.resolve(value ?? { id, name: `T${id}`, status: 'active' }); },
    reject(id, err) { const p = find(id); p.done = true; p.reject(err ?? new Error('404')); },
    signalFor(id) { return find(id)?.signal; },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('tenantController — corrida na troca de tenant', () => {
  it('1. Alpha seguida de Beta: Beta vence mesmo se Alpha responder por último', async () => {
    const gc = makeGetClient();
    const ctrl = createTenantController({ getClient: gc.fn, isSuper: true });
    const pAlpha = ctrl.select(1);
    const pBeta = ctrl.select(2);        // supera Alpha
    gc.resolve(2);                        // Beta responde primeiro
    expect(await pBeta).toBe(true);
    gc.resolve(1);                        // Alpha responde depois (obsoleta)
    expect(await pAlpha).toBe(false);
    expect(ctrl.getState().activeTenant).toEqual({ id: 2, name: 'T2', status: 'active' });
  });

  it('abort: iniciar Beta aborta a requisição de Alpha em andamento', async () => {
    const gc = makeGetClient();
    const ctrl = createTenantController({ getClient: gc.fn, isSuper: true });
    ctrl.select(1);
    const sigAlpha = gc.signalFor(1);
    ctrl.select(2);
    expect(sigAlpha.aborted).toBe(true);
  });

  it('2. Selecionar Alpha e SAIR antes da resposta → permanece global; resposta antiga não reativa', async () => {
    const gc = makeGetClient();
    const ctrl = createTenantController({ getClient: gc.fn, isSuper: true });
    const pAlpha = ctrl.select(1);
    const sig = gc.signalFor(1);
    ctrl.exit();                          // invalida a seleção pendente
    expect(sig.aborted).toBe(true);
    expect(ctrl.getState().activeTenant).toBeNull();
    gc.resolve(1);                        // resposta atrasada de Alpha
    expect(await pAlpha).toBe(false);
    expect(ctrl.getState().activeTenant).toBeNull();  // não reativou
    expect(ctrl.getState().selecting).toBe(false);
  });

  it('3. Seleção inválida não altera o tenant atual nem gera estado inconsistente', async () => {
    const gc = makeGetClient();
    const ctrl = createTenantController({ getClient: gc.fn, isSuper: true });
    const p1 = ctrl.select(1); gc.resolve(1); expect(await p1).toBe(true); // T1 ativo
    const p2 = ctrl.select(2); gc.reject(2); expect(await p2).toBe(false);  // falha
    expect(ctrl.getState().activeTenant).toEqual({ id: 1, name: 'T1', status: 'active' }); // inalterado
    expect(ctrl.getState().error).toBeTruthy();
    expect(ctrl.getState().selecting).toBe(false);
  });

  it('4. Restauração por URL inválida: fica global e loading encerra (wrapper limpa o parâmetro)', async () => {
    const gc = makeGetClient();
    const ctrl = createTenantController({ getClient: gc.fn, isSuper: true });
    const pInit = ctrl.init(999);
    expect(ctrl.getState().loading).toBe(true);
    gc.reject(999);
    expect(await pInit).toBe(false);
    expect(ctrl.getState().activeTenant).toBeNull();
    expect(ctrl.getState().loading).toBe(false);
  });

  it('restauração por URL válida: aplica o tenant', async () => {
    const gc = makeGetClient();
    const ctrl = createTenantController({ getClient: gc.fn, isSuper: true });
    const pInit = ctrl.init(7); gc.resolve(7);
    expect(await pInit).toBe(true);
    expect(ctrl.getState().activeTenant).toEqual({ id: 7, name: 'T7', status: 'active' });
  });

  it('5. Não-superadmin não ativa tenant pela URL (getClient nem é chamado)', async () => {
    const gc = makeGetClient();
    const ctrl = createTenantController({ getClient: gc.fn, isSuper: false });
    expect(await ctrl.init(1)).toBe(false);
    expect(ctrl.getState().activeTenant).toBeNull();
    expect(ctrl.getState().loading).toBe(false);
    expect(gc.calls.length).toBe(0);
  });

  it('dispose cancela requisição pendente', async () => {
    const gc = makeGetClient();
    const ctrl = createTenantController({ getClient: gc.fn, isSuper: true });
    ctrl.select(1);
    const sig = gc.signalFor(1);
    ctrl.dispose();
    expect(sig.aborted).toBe(true);
    await tick();
  });
});
