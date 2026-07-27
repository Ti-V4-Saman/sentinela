// Executa `fn` dentro de uma transação com CONEXÃO DEDICADA quando o pool suporta getConnection
// (produção — mysql2 pool). Faz BEGIN → fn → COMMIT; em qualquer erro, ROLLBACK; sempre libera a
// conexão no finally. A resposta do chamador só deve ser enviada após o retorno (pós-commit).
//
// Em contexto de TESTE, o harness injeta uma ÚNICA conexão (já dentro de uma transação com rollback)
// no lugar do pool — sem getConnection. Nesse caso executamos `fn` direto sobre essa conexão: a
// transação externa do teste garante o isolamento e o rollback ao final.
export async function withTransaction(pool, fn) {
  if (typeof pool.getConnection !== 'function') {
    return fn(pool);
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (e) {
    try { await conn.rollback(); } catch { /* noop */ }
    throw e;
  } finally {
    conn.release();
  }
}
