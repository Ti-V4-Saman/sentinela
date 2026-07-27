import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { getPool, applyMigrations, withTx } from './helpers/db.js';
import { signToken } from '../server/auth/jwt.js';
import { authenticate } from '../server/middleware/authenticate.js';
import { createReportsRouter } from '../server/routes/reports.js';

function makeApp(conn) {
  const a = express();
  a.use(express.json());
  a.use('/api/reports', authenticate, createReportsRouter(conn));
  return a;
}
const bearer = (p) => `Bearer ${signToken(p)}`;
const SUPER = { userId: 900000, tenantId: null, role: 'superadmin' };
const ADMIN1 = { userId: 900050, tenantId: 900001, role: 'admin' };
const ADMIN2 = { userId: 900060, tenantId: 900002, role: 'admin' };
const GESTOR = { userId: 900040, tenantId: 900001, role: 'gestor' };
const USER1 = { userId: 900011, tenantId: 900001, role: 'usuario' };
const R = '?from=2026-07-01&to=2026-07-31';

async function seed(c) {
  await c.query("INSERT INTO tenants (id,name) VALUES (900001,'T1'),(900002,'T2')");
  await c.query(`INSERT INTO users (id,tenant_id,name,email,password_hash,role,status) VALUES
    (900000,NULL,'Super','s@__t','x','superadmin','active'),
    (900050,900001,'Admin1','a1@__t','x','admin','active'),
    (900040,900001,'Gestor','g@__t','x','gestor','active'),
    (900011,900001,'U1','u1@__t','x','usuario','active'),
    (900060,900002,'Admin2','a2@__t','x','admin','active')`);
  await c.query("INSERT INTO instances (wid,tenant_id) VALUES ('W1',900001),('W2',900001),('W3',900002)");
  await c.query(`INSERT INTO sentinela_instances (id,tenant_id,owner_user_id,name,token,capture_wid) VALUES
    ('__i1__',900001,900050,'Inst1','t1','W1'),('__i2__',900001,900050,'Inst2','t2','W2'),('__i3__',900002,900060,'Inst3','t3','W3')`);
  await c.query("INSERT INTO teams (id,tenant_id,name) VALUES (900100,900001,'Comercial')");
  await c.query("INSERT INTO team_instances (team_id,instance_id) VALUES (900100,'__i1__')");
  await c.query(`INSERT INTO contacts (id,tenant_id,phone,name,identification_source,identified_at) VALUES
    ('C1',900001,'5531900000001','Alice','manual','2026-07-25 10:00:00'),
    ('C2',900001,'5531900000002','Bob',NULL,NULL),
    ('C3',900002,'5531900000003','Carol',NULL,NULL)`);
  await c.query(`INSERT INTO chats (id,tenant_id,title,is_group) VALUES
    ('CH1',900001,NULL,0),('CH2',900001,NULL,0),('CHG',900001,'Grupo',1),('CH3',900002,NULL,0)`);
  await c.query(`INSERT INTO messages (id,tenant_id,chat_id,contact_id,text,type,from_me,from_internal,timestamp,wid) VALUES
    ('m1',900001,'CH1','C1','a','text',0,0,'2026-07-01 10:00:00','W1'),
    ('m2',900001,'CH1',NULL,'b','text',1,0,'2026-07-01 10:05:00','W1'),
    ('m3',900001,'CH1','C1','c','audio',0,0,'2026-07-02 09:00:00','W1'),
    ('m4',900001,'CHG','C2','d','image',0,0,'2026-07-02 11:00:00','W1'),
    ('m5',900001,'CH2','C2','e','text',0,0,'2026-07-03 08:00:00','W2'),
    ('m6',900002,'CH3','C3','f','text',0,0,'2026-07-01 10:00:00','W3')`);
}

beforeAll(async () => { process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'; await applyMigrations(); });
afterAll(() => getPool().end());

describe('reports — RBAC', () => {
  it('gestor e usuário → 403', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      expect((await request(app).get(`/api/reports/summary${R}`).set('Authorization', bearer(GESTOR))).status).toBe(403);
      expect((await request(app).get(`/api/reports/summary${R}`).set('Authorization', bearer(USER1))).status).toBe(403);
    });
  });
  it('admin só o próprio tenant; super global e por tenant_id', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const a1 = await request(app).get(`/api/reports/summary${R}`).set('Authorization', bearer(ADMIN1));
      expect(a1.body.messages.total).toBe(5); // só t1
      const a2 = await request(app).get(`/api/reports/summary${R}`).set('Authorization', bearer(ADMIN2));
      expect(a2.body.messages.total).toBe(1); // só t2
      const glob = await request(app).get(`/api/reports/summary${R}`).set('Authorization', bearer(SUPER));
      expect(glob.body.messages.total).toBe(6); // global
      const scoped = await request(app).get(`/api/reports/summary${R}&tenant_id=900001`).set('Authorization', bearer(SUPER));
      expect(scoped.body.messages.total).toBe(5);
    });
  });
});

describe('reports — agregações', () => {
  it('summary: recebidas/enviadas, conversas/grupos, contatos', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get(`/api/reports/summary${R}`).set('Authorization', bearer(ADMIN1));
      expect(r.body.messages).toEqual({ received: 4, sent: 1, total: 5 });
      expect(r.body.conversations).toBe(2); // CH1, CH2
      expect(r.body.groups).toBe(1); // CHG
      expect(r.body.contacts).toEqual({ total: 2, identified: 1, pending: 1 });
    });
  });
  it('daily: agrupa por dia', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get(`/api/reports/daily${R}`).set('Authorization', bearer(ADMIN1));
      const byDate = Object.fromEntries(r.body.daily.map((d) => [String(d.date).slice(0, 10), d]));
      expect(byDate['2026-07-01']).toMatchObject({ received: 1, sent: 1, total: 2 });
      expect(byDate['2026-07-02']).toMatchObject({ received: 2, total: 2 });
      expect(byDate['2026-07-03']).toMatchObject({ received: 1, total: 1 });
    });
  });
  it('by-instance: volume por instância', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get(`/api/reports/by-instance${R}`).set('Authorization', bearer(ADMIN1));
      const byName = Object.fromEntries(r.body.items.map((i) => [i.name, i.total]));
      expect(byName).toEqual({ Inst1: 4, Inst2: 1 });
    });
  });
  it('by-team: volume por equipe (via team_instances → capture_wid)', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get(`/api/reports/by-team${R}`).set('Authorization', bearer(ADMIN1));
      expect(r.body.items).toEqual([{ teamId: 900100, name: 'Comercial', received: 3, sent: 1, total: 4 }]);
    });
  });
  it('media-types: agrupa por tipo', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get(`/api/reports/media-types${R}`).set('Authorization', bearer(ADMIN1));
      const byType = Object.fromEntries(r.body.items.map((i) => [i.type, i.total]));
      expect(byType).toEqual({ text: 3, audio: 1, image: 1 });
    });
  });
});

describe('reports — validação de datas', () => {
  it('sem from/to → 400', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      expect((await request(app).get('/api/reports/summary').set('Authorization', bearer(ADMIN1))).status).toBe(400);
    });
  });
  it('data inválida → 400', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      expect((await request(app).get('/api/reports/summary?from=2026-13-01&to=2026-07-31').set('Authorization', bearer(ADMIN1))).status).toBe(400);
    });
  });
  it('intervalo além do máximo → 400', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      expect((await request(app).get('/api/reports/summary?from=2024-01-01&to=2026-01-01').set('Authorization', bearer(ADMIN1))).status).toBe(400);
    });
  });
});

describe('reports — exportação CSV', () => {
  it('export daily retorna CSV com BOM, cabeçalho e isolamento por tenant', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get(`/api/reports/export?type=daily&from=2026-07-01&to=2026-07-31`).set('Authorization', bearer(ADMIN1));
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toMatch(/text\/csv/);
      expect(r.headers['content-disposition']).toMatch(/attachment; filename="relatorio_daily_2026-07-01_2026-07-31\.csv"/);
      expect(r.text.charCodeAt(0)).toBe(0xfeff); // BOM
      expect(r.text).toContain('Data;Recebidas;Enviadas;Total');
      expect(r.text).toContain('2026-07-01');
    });
  });
  it('type inválido → 400', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      expect((await request(app).get('/api/reports/export?type=hack&from=2026-07-01&to=2026-07-31').set('Authorization', bearer(ADMIN1))).status).toBe(400);
    });
  });
  it('registra a exportação em access_logs', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      await request(app).get('/api/reports/export?type=media-types&from=2026-07-01&to=2026-07-31').set('Authorization', bearer(ADMIN1));
      const [rows] = await c.query("SELECT action, resource, resource_id FROM access_logs WHERE action='export' AND tenant_id=900001");
      expect(rows.length).toBe(1);
      expect(rows[0]).toMatchObject({ action: 'export', resource: 'report', resource_id: 'media-types' });
    });
  });
});
