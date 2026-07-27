import { describe, it, expect } from 'vitest';
import { prependOlder } from '../src/utils/thread.ts';

// Lógica pura da thread (prepend das páginas anteriores + deduplicação por id).
describe('prependOlder — composição da thread no frontend', () => {
  it('insere as mensagens anteriores ANTES das existentes (ordem cronológica preservada)', () => {
    const existing = [{ id: 'p070' }, { id: 'p071' }, { id: 'p072' }]; // página atual (mais recentes)
    const older = [{ id: 'p020' }, { id: 'p021' }, { id: 'p022' }];    // página anterior (mais antigas)
    expect(prependOlder(existing, older).map((m) => m.id))
      .toEqual(['p020', 'p021', 'p022', 'p070', 'p071', 'p072']);
  });

  it('não duplica mensagens já presentes (dedup por id)', () => {
    const existing = [{ id: 'a' }, { id: 'b' }];
    const older = [{ id: 'x' }, { id: 'a' }, { id: 'y' }, { id: 'b' }];
    expect(prependOlder(existing, older).map((m) => m.id)).toEqual(['x', 'y', 'a', 'b']);
  });

  it('página anterior inteiramente duplicada → mantém a lista intacta (mesma referência)', () => {
    const existing = [{ id: 'a' }, { id: 'b' }];
    const out = prependOlder(existing, [{ id: 'a' }, { id: 'b' }]);
    expect(out).toBe(existing); // sem re-render desnecessário
  });

  it('página anterior vazia → mantém a lista intacta', () => {
    const existing = [{ id: 'a' }];
    expect(prependOlder(existing, [])).toBe(existing);
  });
});
