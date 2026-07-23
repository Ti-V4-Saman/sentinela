import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, applyMigrations, withTx } from './helpers/db.js';
import { tenantFilter, visibleInstanceIds } from '../server/middleware/tenantScope.js';

// Seeda dados de teste com IDs sentinela altos (não colidem com dados reais)
// DENTRO da transação recebida; tudo é desfeito no rollback do withTx.
async function seed(conn) {
  await conn.query("INSERT INTO tenants (id, name) VALUES (900001,'T1'),(900002,'T2')");
  await conn.query(`INSERT INTO sentinela_instances (id, tenant_id, name, token) VALUES
    ('__t_i1__',900001,'A','t1'),('__t_i2__',900001,'B','t2'),('__t_i3__',900002,'C','t3')`);
  await conn.query(`INSERT INTO users (id, tenant_id, name, email, password_hash, role) VALUES
    (900010,900001,'Gestor1','g1@__test__','x','gestor'),
    (900011,900001,'User1','u1@__test__','x','usuario')`);
  await conn.query("INSERT INTO teams (id, tenant_id, name) VALUES (900100,900001,'Eq1')");
  await conn.query("INSERT INTO team_managers (team_id, user_id) VALUES (900100,900010)");
  await conn.query("INSERT INTO team_instances (team_id, instance_id) VALUES (900100,'__t_i1__')");
  await conn.query("INSERT INTO user_instances (user_id, instance_id) VALUES (900011,'__t_i2__')");
}

beforeAll(async () => { await applyMigrations(); });
afterAll(() => getPool().end());

describe('tenantFilter (função pura)', () => {
  it('superadmin sem restrição', () => {
    expect(tenantFilter({ role: 'superadmin', tenantId: null }).sql).toBe('');
  });
  it('admin restringe por tenant', () => {
    const f = tenantFilter({ role: 'admin', tenantId: 900001 }, 'm.');
    expect(f.sql).toBe('m.tenant_id = ?');
    expect(f.params).toEqual([900001]);
  });
});

describe('visibleInstanceIds (banco, em transação com rollback)', () => {
  it('admin vê ALL', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      expect(await visibleInstanceIds(conn, { role: 'admin', tenantId: 900001 })).toBe('ALL');
    });
  });
  it('gestor vê instâncias das suas equipes', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const ids = await visibleInstanceIds(conn, { role: 'gestor', tenantId: 900001, userId: 900010 });
      expect(ids).toEqual(['__t_i1__']);
    });
  });
  it('usuario vê só as próprias instâncias', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const ids = await visibleInstanceIds(conn, { role: 'usuario', tenantId: 900001, userId: 900011 });
      expect(ids).toEqual(['__t_i2__']);
    });
  });
});
