import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { getPool, applyMigrations } from './helpers/db.js';
import { signToken } from '../server/auth/jwt.js';
import { authenticate } from '../server/middleware/authenticate.js';
import { createContactTypesRouter } from '../server/routes/contactTypes.js';
import { createContactsRouter } from '../server/routes/contacts.js';

// Estes testes exercitam a ATOMICIDADE real (COMMIT/ROLLBACK) — por isso usam o pool real
// (com getConnection) e COMMITAM, limpando os dados manualmente. Tenants dedicados 990001/990002.
const pool = getPool();
const bearer = (p) => `Bearer ${signToken(p)}`;
const ADMIN = { userId: 990050, tenantId: 990001, role: 'admin' };

function makeApp(p) {
  const a = express();
  a.use(express.json());
  a.use('/api/contact-types', authenticate, createContactTypesRouter(p));
  a.use('/api/contacts', authenticate, createContactsRouter(p));
  return a;
}

// Pool "defeituoso": envolve o pool real e faz `conn.query` LANÇAR quando o SQL casa `shouldFail`.
// `query` (usado por middlewares fora da transação) é delegado ao pool real sem falhar.
function faultyPool(real, shouldFail) {
  return {
    query: (...args) => real.query(...args),
    getConnection: async () => {
      const conn = await real.getConnection();
      const orig = conn.query.bind(conn);
      conn.query = (sql, params) => {
        const text = typeof sql === 'string' ? sql : sql?.sql || '';
        if (shouldFail(text)) throw new Error('INJECTED failure');
        return orig(sql, params);
      };
      return conn;
    },
  };
}

async function cleanup() {
  for (const tid of [990001, 990002]) {
    await pool.query('DELETE FROM messages WHERE tenant_id=?', [tid]);
    await pool.query('DELETE FROM contacts WHERE tenant_id=?', [tid]);
    await pool.query('DELETE FROM contact_types WHERE tenant_id=?', [tid]);
    await pool.query('DELETE FROM sentinela_instances WHERE tenant_id=?', [tid]);
    await pool.query('DELETE FROM instances WHERE tenant_id=?', [tid]);
    await pool.query('DELETE FROM users WHERE tenant_id=?', [tid]);
    await pool.query('DELETE FROM tenants WHERE id=?', [tid]);
  }
}

async function seed() {
  await cleanup();
  await pool.query("INSERT INTO tenants (id,name) VALUES (990001,'TX1'),(990002,'TX2')");
  await pool.query(`INSERT INTO users (id,tenant_id,name,email,password_hash,role,status) VALUES
    (990050,990001,'AdminTX','atx@__test__','x','admin','active'),
    (990051,990001,'UserTX','utx@__test__','x','usuario','active')`);
  // X1/X2 mesmo telefone (para propagação); X3 outro.
  await pool.query(`INSERT INTO contacts (id,tenant_id,phone,name) VALUES
    ('X1',990001,'5544990000001','X um'),
    ('X2',990001,'5544990000001','X dois'),
    ('X3',990001,'5544990000002','X tres')`);
}

beforeAll(async () => { process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'; await applyMigrations(); });
beforeEach(seed);
afterEach(cleanup);
afterAll(() => pool.end());

const srcOf = async (id) => (await pool.query(`SELECT identification_source s, display_name d FROM contacts WHERE tenant_id=990001 AND id='${id}'`))[0][0];

describe('identify — atomicidade (rollback na propagação)', () => {
  it('1-3. falha na propagação → ROLLBACK: contato principal restaurado, duplicado preservado', async () => {
    const app = makeApp(faultyPool(pool, (sql) => /identification_source = 'auto'/.test(sql)));
    const r = await request(app).put('/api/contacts/X1/identify').set('Authorization', bearer(ADMIN)).send({ displayName: 'X um VIP' });
    expect(r.status).toBe(500);
    expect((await srcOf('X1')).s).toBeNull(); // principal NÃO ficou parcialmente alterado
    expect((await srcOf('X2')).s).toBeNull(); // duplicado preservado
  });
  it('4. sucesso persiste todos os registros (principal manual + duplicado auto)', async () => {
    const app = makeApp(pool);
    const r = await request(app).put('/api/contacts/X1/identify').set('Authorization', bearer(ADMIN)).send({ displayName: 'X um VIP' });
    expect(r.status).toBe(200);
    expect(await srcOf('X1')).toMatchObject({ s: 'manual', d: 'X um VIP' });
    expect(await srcOf('X2')).toMatchObject({ s: 'auto', d: 'X um VIP' });
  });
  it('5. identificação manual existente nunca é sobrescrita pela propagação', async () => {
    await pool.query("UPDATE contacts SET display_name='X dois MANUAL', identification_source='manual', identified_by_user_id=990050, identified_at=NOW() WHERE tenant_id=990001 AND id='X2'");
    const app = makeApp(pool);
    const r = await request(app).put('/api/contacts/X1/identify').set('Authorization', bearer(ADMIN)).send({ displayName: 'X um VIP' });
    expect(r.body.propagated).toBe(0);
    expect(await srcOf('X2')).toMatchObject({ s: 'manual', d: 'X dois MANUAL' });
  });
  it('6. nenhuma conexão fica presa após erros repetidos (pool não esgota)', async () => {
    const faulty = makeApp(faultyPool(pool, (sql) => /identification_source = 'auto'/.test(sql)));
    // Mais requisições com erro do que o connectionLimit (5) — se vazasse conexão, esgotaria e travaria.
    for (let i = 0; i < 8; i += 1) {
      const r = await request(faulty).put('/api/contacts/X1/identify').set('Authorization', bearer(ADMIN)).send({ displayName: 'x' });
      expect(r.status).toBe(500);
    }
    const ok = await request(makeApp(pool)).put('/api/contacts/X1/identify').set('Authorization', bearer(ADMIN)).send({ displayName: 'depois' });
    expect(ok.status).toBe(200); // pool ainda utilizável → conexões foram liberadas
  });
});

describe('exclusão de tipo — atomicidade', () => {
  async function makeTypeWithContact() {
    const app = makeApp(pool);
    const t = (await request(app).post('/api/contact-types').set('Authorization', bearer(ADMIN)).send({ name: 'Lead', color: 'info' })).body.id;
    await pool.query('UPDATE contacts SET contact_type_id=? WHERE tenant_id=990001 AND id=? ', [t, 'X3']);
    return t;
  }
  it('1-3. falha no DELETE após o UPDATE → ROLLBACK: contatos continuam vinculados e o tipo permanece', async () => {
    const t = await makeTypeWithContact();
    const app = makeApp(faultyPool(pool, (sql) => /DELETE FROM contact_types/.test(sql)));
    const r = await request(app).delete(`/api/contact-types/${t}`).set('Authorization', bearer(ADMIN));
    expect(r.status).toBe(500);
    const [ct] = await pool.query('SELECT contact_type_id FROM contacts WHERE tenant_id=990001 AND id=?', ['X3']);
    expect(Number(ct[0].contact_type_id)).toBe(Number(t)); // continua vinculado
    const [ty] = await pool.query('SELECT COUNT(*) n FROM contact_types WHERE id=?', [t]);
    expect(ty[0].n).toBe(1); // tipo continua existente
  });
  it('4. sucesso remove o tipo e desvincula os contatos', async () => {
    const t = await makeTypeWithContact();
    const r = await request(makeApp(pool)).delete(`/api/contact-types/${t}`).set('Authorization', bearer(ADMIN));
    expect(r.status).toBe(200);
    const [ct] = await pool.query('SELECT contact_type_id FROM contacts WHERE tenant_id=990001 AND id=?', ['X3']);
    expect(ct[0].contact_type_id).toBeNull();
    const [ty] = await pool.query('SELECT COUNT(*) n FROM contact_types WHERE id=?', [t]);
    expect(ty[0].n).toBe(0);
  });
  it('5. nenhum contato de OUTRO tenant é alterado', async () => {
    const app = makeApp(pool);
    const t1 = (await request(app).post('/api/contact-types').set('Authorization', bearer(ADMIN)).send({ name: 'Lead', color: 'info' })).body.id;
    await pool.query('UPDATE contacts SET contact_type_id=? WHERE tenant_id=990001 AND id=?', [t1, 'X3']);
    // tenant 990002 com tipo e contato próprios
    await pool.query("INSERT INTO contact_types (id,tenant_id,name,color) VALUES (990900,990002,'Lead','info')");
    await pool.query("INSERT INTO contacts (id,tenant_id,phone,name,contact_type_id) VALUES ('Y1',990002,'5544990000009','Y um',990900)");
    const r = await request(app).delete(`/api/contact-types/${t1}`).set('Authorization', bearer(ADMIN));
    expect(r.status).toBe(200);
    const [y] = await pool.query('SELECT contact_type_id FROM contacts WHERE tenant_id=990002 AND id=?', ['Y1']);
    expect(Number(y[0].contact_type_id)).toBe(990900); // intacto
  });
});
