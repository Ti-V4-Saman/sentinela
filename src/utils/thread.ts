// Lógica pura de composição da thread (sem DOM) — testável isoladamente.

export type WithId = { id: string };

// Faz o PREPEND de uma página de mensagens mais antigas (já em ordem cronológica) acima das
// já carregadas, deduplicando por `id`. Preserva a ordem cronológica global:
//   [ ...antigas ainda não vistas, ...existentes ]
// A deduplicação é uma rede de segurança: a paginação do backend não sobrepõe páginas, mas um
// clique duplo / resposta repetida nunca deve inserir a mesma mensagem duas vezes.
export function prependOlder<T extends WithId>(existing: T[], older: T[]): T[] {
  if (!older.length) return existing;
  const seen = new Set(existing.map((m) => m.id));
  const fresh = older.filter((m) => !seen.has(m.id));
  if (!fresh.length) return existing;
  return [...fresh, ...existing];
}
