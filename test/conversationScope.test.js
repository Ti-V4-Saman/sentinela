import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, applyMigrations, withTx } from './helpers/db.js';
import { visibleCaptureWids, messageTextSearch } from '../server/middleware/conversationScope.js';

// t1=900001: admin 900050, gestor 900040, usuario 900011, usuario 900012
// t2=900002: usuario 900013
// sentinela_instances mapeadas: __i1__→W1 (t1), __i2__→W2 (t1), __i3__→W3 (t2), __i0__→NULL (t1)
// team 900100 (t1) gerenciada por 900040, team_instances → __i1__
// user_instances: 900011 → __i1__ ; 900012 → __i0__ (mapeada p/ instância SEM capture_wid)
async function seed(conn) {
  await conn.query("INSERT INTO tenants (id,name) VALUES (900001,'T1'),(900002,'T2')");
  await conn.query(`INSERT INTO users (id,tenant_id,name,email,password_hash,role,status) VALUES
    (900050,900001,'A','a@__test__','x','admin','active'),
    (900040,900001,'G','g@__test__','x','gestor','active'),
    (900011,900001,'U1','u1@__test__','x','usuario','active'),
    (900012,900001,'U2','u2@__test__','x','usuario','active'),
    (900013,900002,'U3','u3@__test__','x','usuario','active')`);
  await conn.query(`INSERT INTO sentinela_instances (id,tenant_id,owner_user_id,name,token,capture_wid) VALUES
    ('__i1__',900001,900011,'A','t1','W1'),
    ('__i2__',900001,900012,'B','t2','W2'),
    ('__i3__',900002,900013,'C','t3','W3'),
    ('__i0__',900001,900011,'Z','t0',NULL)`);
  await conn.query("INSERT INTO teams (id,tenant_id,name) VALUES (900100,900001,'Eq1'),(900101,900001,'Eq2')");
  await conn.query("INSERT INTO team_managers (team_id,user_id) VALUES (900100,900040),(900101,900040)");
  await conn.query("INSERT INTO team_instances (team_id,instance_id) VALUES (900100,'__i1__'),(900101,'__i2__')");
  await conn.query("INSERT INTO user_instances (user_id,instance_id) VALUES (900011,'__i1__'),(900012,'__i0__')");
}

const actor = (over) => ({ id: null, role: 'usuario', status: 'active', tenant_id: 900001, ...over });

beforeAll(async () => { await applyMigrations(); });
afterAll(() => getPool().end());

describe('visibleCaptureWids (fonte da verdade: vínculos explícitos + capture_wid)', () => {
  it('superadmin → ALL', async () => {
    await withTx(async (c) => { expect(await visibleCaptureWids(c, actor({ role: 'superadmin', tenant_id: null }))).toBe('ALL'); });
  });
  it('admin → ALL (tenant filter escopa)', async () => {
    await withTx(async (c) => { await seed(c); expect(await visibleCaptureWids(c, actor({ role: 'admin', id: 900050 }))).toBe('ALL'); });
  });
  it('gestor → união dos team_instances das equipes geridas (capture_wid não-nulo)', async () => {
    await withTx(async (c) => {
      await seed(c);
      const wids = await visibleCaptureWids(c, actor({ role: 'gestor', id: 900040 }));
      expect([...wids].sort()).toEqual(['W1', 'W2']); // duas equipes
    });
  });
  it('usuario → apenas user_instances mapeadas (capture_wid não-nulo)', async () => {
    await withTx(async (c) => {
      await seed(c);
      expect(await visibleCaptureWids(c, actor({ role: 'usuario', id: 900011 }))).toEqual(['W1']);
    });
  });
  it('usuario vinculado a instância SEM capture_wid → vazio (fail-closed)', async () => {
    await withTx(async (c) => {
      await seed(c);
      expect(await visibleCaptureWids(c, actor({ role: 'usuario', id: 900012 }))).toEqual([]);
    });
  });
  it('usuario sem nenhum user_instances → vazio (não herda por tenant)', async () => {
    await withTx(async (c) => {
      await seed(c);
      expect(await visibleCaptureWids(c, actor({ role: 'usuario', id: 900013, tenant_id: 900002 }))).toEqual([]);
    });
  });
});

describe('messageTextSearch (caminhos separados: none | like | fulltext)', () => {
  it('vazio → mode none (sem cláusula)', () => {
    expect(messageTextSearch('m.text', '')).toEqual({ mode: 'none', sql: '', params: [] });
  });
  it('termo curto (<3) → mode like', () => {
    const r = messageTextSearch('m.text', 'ab');
    expect(r.mode).toBe('like'); expect(r.sql).toBe('m.text LIKE ?'); expect(r.params).toEqual(['%ab%']);
  });
  it('sem token compatível (só tokens curtos) → mode like', () => {
    const r = messageTextSearch('m.text', 'a b c');
    expect(r.mode).toBe('like'); expect(r.params).toEqual(['%a b c%']);
  });
  it('só operadores/sem conteúdo → mode like sobre o termo original', () => {
    const r = messageTextSearch('m.text', '()+-');
    expect(r.mode).toBe('like'); expect(r.params).toEqual(['%()+-%']);
  });
  it('termo normal → mode fulltext (MATCH AGAINST boolean, prefixo, SEM OR LIKE)', () => {
    const r = messageTextSearch('m.text', 'palavra');
    expect(r.mode).toBe('fulltext');
    expect(r.sql).toBe('MATCH(m.text) AGAINST(? IN BOOLEAN MODE)');
    expect(r.sql).not.toMatch(/LIKE/);
    expect(r.params).toEqual(['palavra*']);
  });
  it('operadores boolean removidos, mantendo o token → fulltext', () => {
    const r = messageTextSearch('m.text', '+palavra');
    expect(r.mode).toBe('fulltext'); expect(r.params).toEqual(['palavra*']);
    expect(r.params[0]).not.toMatch(/[+\-()]/);
  });
});
