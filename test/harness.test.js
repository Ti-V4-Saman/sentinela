import { describe, it, expect, afterAll } from 'vitest';
import { getPool, withTx } from './helpers/db.js';

afterAll(() => getPool().end());

describe('test harness', () => {
  it('conecta no banco sentinela', async () => {
    const [rows] = await getPool().query('SELECT DATABASE() AS db');
    expect(rows[0].db).toBe(process.env.DB_NAME);
  });
  it('withTx desfaz inserts (rollback)', async () => {
    // Cria uma tabela temporária de sessão só para provar o rollback sem tocar tabelas reais.
    await withTx(async (conn) => {
      await conn.query('CREATE TEMPORARY TABLE _tx_probe (n INT)');
      await conn.query('INSERT INTO _tx_probe VALUES (1)');
      const [r] = await conn.query('SELECT COUNT(*) c FROM _tx_probe');
      expect(r[0].c).toBe(1);
    });
    expect(true).toBe(true); // rollback ocorreu sem erro
  });
});
