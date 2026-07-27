import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { getPool, applyMigrations, withTx } from './helpers/db.js';
import { signToken } from '../server/auth/jwt.js';
import { authenticate } from '../server/middleware/authenticate.js';
import { createClientsRouter } from '../server/routes/clients.js';
import { createChatsRouter } from '../server/routes/chats.js';

function makeApp(conn) {
  const a = express();
  a.use(express.json());
  a.use('/api/clients', authenticate, createClientsRouter(conn));
  a.use('/api/chats', authenticate, createChatsRouter(conn));
  return a;
}
const bearer = (p) => `Bearer ${signToken(p)}`;

const SUPER = { userId: 900000, tenantId: null, role: 'superadmin' };
const ADMIN1 = { userId: 900050, tenantId: 900001, role: 'admin' };
const ADMIN2 = { userId: 900060, tenantId: 900002, role: 'admin' };
const GESTOR = { userId: 900040, tenantId: 900001, role: 'gestor' };
const USER1 = { userId: 900011, tenantId: 900001, role: 'usuario' };

// T1: 2 instâncias (1 conectada+capturada, 1 desconectada sem captura), 3 usuários, 1 equipe,
// 1 conversa individual + 1 grupo, 2 contatos (1 identificado, 1 pendente). T2: dados próprios.
async function seed(c) {
  await c.query("INSERT INTO tenants (id,name,status) VALUES (900001,'T1','active'),(900002,'T2','active')");
  await c.query(`INSERT INTO users (id,tenant_id,name,email,password_hash,role,status) VALUES
    (900000,NULL,'Super','s@__test__','x','superadmin','active'),
    (900050,900001,'Admin1','a1@__test__','x','admin','active'),
    (900040,900001,'Gestor','g@__test__','x','gestor','active'),
    (900011,900001,'U1','u1@__test__','x','usuario','active'),
    (900060,900002,'Admin2','a2@__test__','x','admin','active')`);
  await c.query("INSERT INTO instances (wid,tenant_id) VALUES ('W1',900001),('W2',900001),('W3',900002)");
  await c.query(`INSERT INTO sentinela_instances (id,tenant_id,owner_user_id,name,token,status,phone_number,capture_wid) VALUES
    ('__i1__',900001,900050,'Conectada','tok1','Connected','5531988880001','W1'),
    ('__i2__',900001,900050,'Offline','tok2','Disconnected','5531988880002',NULL),
    ('__i3__',900002,900060,'OutraT2','tok3','Connected','5531988880003','W3')`);
  await c.query("INSERT INTO teams (id,tenant_id,name) VALUES (900100,900001,'Comercial')");
  await c.query("INSERT INTO team_managers (team_id,user_id) VALUES (900100,900040)");
  await c.query("INSERT INTO team_users (team_id,user_id) VALUES (900100,900011)");
  await c.query("INSERT INTO team_instances (team_id,instance_id) VALUES (900100,'__i1__')");
  await c.query(`INSERT INTO contact_types (id,tenant_id,name,color) VALUES (900700,900001,'Lead','info')`);
  await c.query(`INSERT INTO contacts (id,tenant_id,phone,name,display_name,contact_type_id,identification_source,identified_by_user_id,identified_at) VALUES
    ('C1',900001,'5531900000001','Alice','Alice VIP',900700,'manual',900050,'2026-07-25 10:00:00')`);
  await c.query("INSERT INTO contacts (id,tenant_id,phone,name) VALUES ('C2',900001,'5531900000002','Bob'),('C3',900002,'5531900000003','Carol')");
  await c.query(`INSERT INTO chats (id,tenant_id,title,is_group) VALUES
    ('CH1',900001,NULL,0),('CHG',900001,'Grupo T1',1),('CHV',900001,'SemMsg',0),('CH3',900002,NULL,0)`);
  await c.query(`INSERT INTO messages (id,tenant_id,chat_id,contact_id,text,type,from_me,from_internal,timestamp,wid) VALUES
    ('m1',900001,'CH1','C1','oi alice','text',0,0,'2026-07-20 10:00:00','W1'),
    ('m2',900001,'CH1','C1','tudo bem?','text',0,0,'2026-07-20 10:01:00','W1'),
    ('g1',900001,'CHG','C2','mensagem no grupo','text',0,0,'2026-07-20 11:00:00','W1'),
    ('m3',900002,'CH3','C3','de outro tenant','text',0,0,'2026-07-20 10:00:00','W3')`);
}

beforeAll(async () => { process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'; await applyMigrations(); });
afterAll(() => getPool().end());

describe('drill-down — RBAC e isolamento', () => {
  it('superadmin abre qualquer cliente', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      expect((await request(app).get('/api/clients/900001/overview').set('Authorization', bearer(SUPER))).status).toBe(200);
      expect((await request(app).get('/api/clients/900002/overview').set('Authorization', bearer(SUPER))).status).toBe(200);
    });
  });
  it('admin abre o próprio tenant; outro tenant → 404 (não revela existência)', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      expect((await request(app).get('/api/clients/900001/overview').set('Authorization', bearer(ADMIN1))).status).toBe(200);
      expect((await request(app).get('/api/clients/900002/overview').set('Authorization', bearer(ADMIN1))).status).toBe(404);
    });
  });
  it('gestor e usuário não acessam o drill-down (403)', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      expect((await request(app).get('/api/clients/900001/overview').set('Authorization', bearer(GESTOR))).status).toBe(403);
      expect((await request(app).get('/api/clients/900001/users').set('Authorization', bearer(USER1))).status).toBe(403);
    });
  });
  it('tenant inexistente → 404', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      expect((await request(app).get('/api/clients/999999/overview').set('Authorization', bearer(SUPER))).status).toBe(404);
    });
  });
});

describe('drill-down — overview (KPIs)', () => {
  it('agrega apenas os dados do tenant', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/clients/900001/overview').set('Authorization', bearer(SUPER));
      expect(r.body.client).toMatchObject({ id: 900001, name: 'T1', status: 'active' });
      expect(r.body.kpis.instances).toEqual({ total: 2, connected: 1, captureMapped: 1, captureUnmapped: 1 });
      expect(r.body.kpis.conversations).toBe(1); // CH1 (CHV não tem mensagens)
      expect(r.body.kpis.groups).toBe(1); // CHG
      expect(r.body.kpis.users).toEqual({ total: 3, byRole: { admin: 1, gestor: 1, usuario: 1 } });
      expect(r.body.kpis.teams).toBe(1);
      expect(r.body.kpis.contacts).toEqual({ total: 2, identified: 1, pending: 1 });
      expect(r.body.kpis.messages).toBe(3); // só t1
    });
  });
});

describe('drill-down — tabelas paginadas e campos seguros', () => {
  it('instâncias: paginado, capture como booleano, SEM token/wid/webhook', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/clients/900001/instances?limit=1&page=1').set('Authorization', bearer(SUPER));
      expect(r.body.total).toBe(2);
      expect(r.body.instances).toHaveLength(1);
      const inst = r.body.instances[0];
      expect(inst).toHaveProperty('captureMapped');
      expect(inst).not.toHaveProperty('captureWid');
      expect(inst).not.toHaveProperty('capture_wid');
      expect(inst).not.toHaveProperty('token');
      expect(inst).not.toHaveProperty('webhookUrl');
      expect(JSON.stringify(r.body)).not.toMatch(/W1|W2|tok1|tok2/); // nenhum wid/token vaza
      const p2 = await request(app).get('/api/clients/900001/instances?limit=1&page=2').set('Authorization', bearer(SUPER));
      expect(p2.body.instances[0].id).not.toBe(inst.id); // página distinta
    });
  });
  it('usuários: paginado e SEM password_hash', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/clients/900001/users').set('Authorization', bearer(SUPER));
      expect(r.body.total).toBe(3);
      expect(r.body.users.every((u) => !('password_hash' in u) && !('passwordHash' in u))).toBe(true);
      expect(r.body.users.map((u) => u.role).sort()).toEqual(['admin', 'gestor', 'usuario']);
    });
  });
  it('equipes: contagens de vínculos', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/clients/900001/teams').set('Authorization', bearer(SUPER));
      expect(r.body.total).toBe(1);
      expect(r.body.teams[0]).toMatchObject({ name: 'Comercial', userCount: 1, managerCount: 1, instanceCount: 1 });
    });
  });
  it('contatos: filtro identified/pending', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const idf = await request(app).get('/api/clients/900001/contacts?status=identified').set('Authorization', bearer(SUPER));
      expect(idf.body.contacts.map((x) => x.id)).toEqual(['C1']);
      expect(idf.body.contacts[0]).toMatchObject({ displayName: 'Alice VIP', identified: true, type: { name: 'Lead' } });
      const pend = await request(app).get('/api/clients/900001/contacts?status=pending').set('Authorization', bearer(SUPER));
      expect(pend.body.contacts.map((x) => x.id)).toEqual(['C2']);
    });
  });
  it('admin no próprio tenant vê as tabelas; não vê o outro', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      expect((await request(app).get('/api/clients/900001/users').set('Authorization', bearer(ADMIN1))).body.total).toBe(3);
      expect((await request(app).get('/api/clients/900002/users').set('Authorization', bearer(ADMIN1))).status).toBe(404);
      // Admin2 vê só T2 (1 contato)
      expect((await request(app).get('/api/clients/900002/contacts').set('Authorization', bearer(ADMIN2))).body.total).toBe(1);
    });
  });
});

describe('drill-down — conversas via /api/chats?tenant_id (superadmin)', () => {
  it('escopa a listagem a um cliente', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const t1 = await request(app).get('/api/chats?tenant_id=900001').set('Authorization', bearer(SUPER));
      expect(t1.body.chats.map((x) => x.id).sort()).toEqual(['CH1', 'CHG']);
      const t2 = await request(app).get('/api/chats?tenant_id=900002').set('Authorization', bearer(SUPER));
      expect(t2.body.chats.map((x) => x.id)).toEqual(['CH3']);
      const grp = await request(app).get('/api/chats?tenant_id=900001&is_group=1').set('Authorization', bearer(SUPER));
      expect(grp.body.chats.map((x) => x.id)).toEqual(['CHG']);
    });
  });
});
