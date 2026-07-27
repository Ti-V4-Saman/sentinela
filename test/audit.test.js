import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { getPool, applyMigrations, withTx } from './helpers/db.js';
import { signToken } from '../server/auth/jwt.js';
import { hashPassword } from '../server/auth/password.js';
import { authenticate } from '../server/middleware/authenticate.js';
import { createAuthRouter } from '../server/routes/auth.js';
import { createContactsRouter } from '../server/routes/contacts.js';
import { createAuditRouter } from '../server/routes/audit.js';
import { writeAudit, AUDIT_ACTIONS, AUDIT_RESOURCES } from '../server/audit.js';

function makeApp(conn) {
  const a = express();
  a.set('trust proxy', 1);
  a.use(express.json());
  a.use('/api/auth', createAuthRouter(conn));
  a.use('/api/contacts', authenticate, createContactsRouter(conn));
  a.use('/api/audit', authenticate, createAuditRouter(conn));
  return a;
}
const bearer = (p) => `Bearer ${signToken(p)}`;
const SUPER = { userId: 900000, tenantId: null, role: 'superadmin' };
const ADMIN1 = { userId: 900050, tenantId: 900001, role: 'admin' };
const ADMIN2 = { userId: 900060, tenantId: 900002, role: 'admin' };
const GESTOR = { userId: 900040, tenantId: 900001, role: 'gestor' };
const USER1 = { userId: 900011, tenantId: 900001, role: 'usuario' };

async function seed(c) {
  // access_logs é uma tabela GLOBAL e gravável (inclui eventos com tenant_id NULL, ex.: login_failed).
  // Limpamos dentro da transação do teste (rolls back) para isolar as contagens de qualquer resíduo
  // commitado por outros contextos.
  await c.query('DELETE FROM access_logs');
  const h = await hashPassword('Secret#123');
  await c.query("INSERT INTO tenants (id,name) VALUES (900001,'T1'),(900002,'T2')");
  await c.query(`INSERT INTO users (id,tenant_id,name,email,password_hash,role,status) VALUES
    (900000,NULL,'Super','s@__t',?, 'superadmin','active'),
    (900050,900001,'Admin1','admin1@__t',?, 'admin','active'),
    (900040,900001,'Gestor','g@__t',?, 'gestor','active'),
    (900011,900001,'U1','u1@__t',?, 'usuario','active'),
    (900060,900002,'Admin2','admin2@__t',?, 'admin','active')`, [h, h, h, h, h]);
  await c.query("INSERT INTO contacts (id,tenant_id,phone,name) VALUES ('C1',900001,'5531900000001','Alice')");
}

beforeAll(async () => { process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'; await applyMigrations(); });
afterAll(() => getPool().end());

describe('audit — registro de eventos', () => {
  it('login bem-sucedido gera evento login (tenant + ator)', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).post('/api/auth/login').send({ email: 'admin1@__t', password: 'Secret#123' });
      expect(r.status).toBe(200);
      const [rows] = await c.query("SELECT action, tenant_id, actor_user_id, status FROM access_logs WHERE action='login'");
      expect(rows.length).toBe(1);
      expect(rows[0]).toMatchObject({ action: 'login', tenant_id: 900001, actor_user_id: 900050, status: 'ok' });
    });
  });
  it('falha de login gera evento login_failed SEM ator/email', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).post('/api/auth/login').send({ email: 'admin1@__t', password: 'errada' });
      expect(r.status).toBe(401);
      const [rows] = await c.query("SELECT action, actor_user_id, status FROM access_logs WHERE action='login_failed'");
      expect(rows.length).toBe(1);
      expect(rows[0]).toMatchObject({ actor_user_id: null, status: 'fail' });
    });
  });
  it('identificar contato gera evento identify_contact', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      await request(app).put('/api/contacts/C1/identify').set('Authorization', bearer(ADMIN1)).send({ displayName: 'Alice VIP' });
      const [rows] = await c.query("SELECT action, resource, resource_id, tenant_id FROM access_logs WHERE action='identify_contact'");
      expect(rows.length).toBe(1);
      expect(rows[0]).toMatchObject({ resource: 'contact', resource_id: 'C1', tenant_id: 900001 });
    });
  });
  it('nenhum log guarda conteúdo sensível (sem texto de mensagem/senha)', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      await request(app).post('/api/auth/login').send({ email: 'admin1@__t', password: 'Secret#123' });
      const [rows] = await c.query('SELECT * FROM access_logs');
      const dump = JSON.stringify(rows);
      expect(dump).not.toMatch(/Secret#123/);
      expect(dump).not.toMatch(/password_hash/);
    });
  });
});

describe('audit — listagem, RBAC e isolamento', () => {
  it('gestor e usuário → 403', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      expect((await request(app).get('/api/audit').set('Authorization', bearer(GESTOR))).status).toBe(403);
      expect((await request(app).get('/api/audit').set('Authorization', bearer(USER1))).status).toBe(403);
    });
  });
  it('admin vê só o próprio tenant; super vê tudo e filtra por tenant_id', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      await request(app).post('/api/auth/login').send({ email: 'admin1@__t', password: 'Secret#123' }); // log t1
      await request(app).post('/api/auth/login').send({ email: 'admin2@__t', password: 'Secret#123' }); // log t2
      const a1 = await request(app).get('/api/audit?action=login').set('Authorization', bearer(ADMIN1));
      expect(a1.body.logs.every((l) => l.action === 'login')).toBe(true);
      expect(a1.body.total).toBe(1); // só t1
      const a2 = await request(app).get('/api/audit?action=login').set('Authorization', bearer(ADMIN2));
      expect(a2.body.total).toBe(1); // só t2
      const glob = await request(app).get('/api/audit?action=login').set('Authorization', bearer(SUPER));
      expect(glob.body.total).toBe(2);
      const scoped = await request(app).get('/api/audit?action=login&tenant_id=900001').set('Authorization', bearer(SUPER));
      expect(scoped.body.total).toBe(1);
    });
  });
  it('filtro por action', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      await request(app).post('/api/auth/login').send({ email: 'admin1@__t', password: 'Secret#123' });
      await request(app).put('/api/contacts/C1/identify').set('Authorization', bearer(ADMIN1)).send({ displayName: 'X' });
      const only = await request(app).get('/api/audit?action=identify_contact').set('Authorization', bearer(SUPER));
      expect(only.body.logs.every((l) => l.action === 'identify_contact')).toBe(true);
      expect(only.body.total).toBe(1);
    });
  });
});

describe('audit — writeAudit (política de falha e lista fechada)', () => {
  it('ação/recurso fora da lista fechada NÃO grava', async () => {
    let called = 0;
    const fakePool = { query: async () => { called += 1; } };
    await writeAudit(fakePool, { action: 'hackzor', resource: 'auth' });
    await writeAudit(fakePool, { action: 'login', resource: 'inexistente' });
    expect(called).toBe(0);
  });
  it('falha ao gravar NÃO propaga erro (rota não cai)', async () => {
    const brokenPool = { query: async () => { throw new Error('db down'); } };
    await expect(writeAudit(brokenPool, { action: 'login', resource: 'auth' })).resolves.toBeUndefined();
  });
  it('as listas fechadas contêm as ações/recursos esperados', () => {
    expect(AUDIT_ACTIONS.has('view_thread')).toBe(true);
    expect(AUDIT_ACTIONS.has('export')).toBe(true);
    expect(AUDIT_RESOURCES.has('report')).toBe(true);
  });
});
