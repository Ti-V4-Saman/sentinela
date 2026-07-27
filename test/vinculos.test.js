import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { getPool, applyMigrations, withTx } from './helpers/db.js';
import { signToken } from '../server/auth/jwt.js';
import { authenticate } from '../server/middleware/authenticate.js';
import { createUsersRouter } from '../server/routes/users.js';
import { createInstancesRouter } from '../server/routes/instances.js';

function makeApp(conn) {
  const a = express();
  a.use(express.json());
  a.use('/api/users', authenticate, createUsersRouter(conn));
  a.use('/api/instances', authenticate, createInstancesRouter(conn));
  return a;
}
const bearer = (p) => `Bearer ${signToken(p)}`;
const ADMIN = { userId: 900050, tenantId: 900001, role: 'admin' };
const USER1 = { userId: 900011, tenantId: 900001, role: 'usuario' };

// t1=900001: admin 900050, gestor 900040, usuario 900011/900012. t2=900002: usuario 900013.
// sentinela_instances: __i1__(t1, cap W1), __i2__(t1, cap NULL), __i3__(t2, cap W3).
// instances (captura): W1,W2(t1), W3(t2).  W2 é livre; W1 já usado por __i1__.
async function seed(conn) {
  await conn.query("INSERT INTO tenants (id,name) VALUES (900001,'T1'),(900002,'T2')");
  await conn.query(`INSERT INTO users (id,tenant_id,name,email,password_hash,role,status) VALUES
    (900050,900001,'Admin','a@__test__','x','admin','active'),
    (900040,900001,'Gestor','g@__test__','x','gestor','active'),
    (900011,900001,'U1','u1@__test__','x','usuario','active'),
    (900012,900001,'U2','u2@__test__','x','usuario','active'),
    (900013,900002,'U3','u3@__test__','x','usuario','active')`);
  await conn.query("INSERT INTO instances (wid,tenant_id) VALUES ('W1',900001),('W2',900001),('W3',900002)");
  await conn.query(`INSERT INTO sentinela_instances (id,tenant_id,owner_user_id,name,token,capture_wid) VALUES
    ('__i1__',900001,900011,'A','t1','W1'),
    ('__i2__',900001,900012,'B','t2',NULL),
    ('__i3__',900002,900013,'C','t3','W3')`);
}
const ids = (arr) => arr.map((x) => x.id).sort();

beforeAll(async () => { process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'; await applyMigrations(); });
afterAll(() => getPool().end());

describe('user_instances (admin/superadmin)', () => {
  it('vincular a usuário + listar (com estado de captura)', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const ok = await request(app).post('/api/users/900011/instances').set('Authorization', bearer(ADMIN)).send({ instanceId: '__i1__' });
      expect(ok.status).toBe(201);
      const list = await request(app).get('/api/users/900011/instances').set('Authorization', bearer(ADMIN));
      expect(ids(list.body)).toEqual(['__i1__']);
      expect(list.body[0].captureMapped).toBe(true);
    });
  });
  it('instância sem capture_wid vincula, mas captureMapped=false', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      await request(app).post('/api/users/900011/instances').set('Authorization', bearer(ADMIN)).send({ instanceId: '__i2__' });
      const list = await request(app).get('/api/users/900011/instances').set('Authorization', bearer(ADMIN));
      expect(list.body[0].captureMapped).toBe(false);
    });
  });
  it('alvo com papel ≠ usuario → 400', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).post('/api/users/900040/instances').set('Authorization', bearer(ADMIN)).send({ instanceId: '__i1__' });
      expect(r.status).toBe(400);
    });
  });
  it('instância de outro tenant → 404 (cross-tenant)', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).post('/api/users/900011/instances').set('Authorization', bearer(ADMIN)).send({ instanceId: '__i3__' });
      expect(r.status).toBe(404);
    });
  });
  it('duplicado → 409; desvincular → 200; desvincular inexistente → 404', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      await request(app).post('/api/users/900011/instances').set('Authorization', bearer(ADMIN)).send({ instanceId: '__i1__' });
      const dup = await request(app).post('/api/users/900011/instances').set('Authorization', bearer(ADMIN)).send({ instanceId: '__i1__' });
      expect(dup.status).toBe(409);
      const del = await request(app).delete('/api/users/900011/instances/__i1__').set('Authorization', bearer(ADMIN));
      expect(del.status).toBe(200);
      const del2 = await request(app).delete('/api/users/900011/instances/__i1__').set('Authorization', bearer(ADMIN));
      expect(del2.status).toBe(404);
    });
  });
  it('usuário comum não altera vínculos (router exige admin/superadmin → 403)', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/users/900011/instances').set('Authorization', bearer(USER1));
      expect(r.status).toBe(403);
    });
  });
  it('admin não gerencia usuário de outro tenant → 404', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).post('/api/users/900013/instances').set('Authorization', bearer(ADMIN)).send({ instanceId: '__i3__' });
      expect(r.status).toBe(404);
    });
  });
});

describe('capture_wid: candidatos e exposição na listagem', () => {
  it('captureWid/captureMapped aparecem na listagem de instâncias', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/instances').set('Authorization', bearer(ADMIN));
      const i1 = r.body.find((x) => x.id === '__i1__');
      const i2 = r.body.find((x) => x.id === '__i2__');
      expect(i1.captureMapped).toBe(true); expect(i1.captureWid).toBe('W1');
      expect(i2.captureMapped).toBe(false); expect(i2.captureWid).toBe(null);
    });
  });
  it('candidatos = wids do tenant não usados por OUTRA instância (mantém o atual)', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const forI2 = await request(app).get('/api/instances/__i2__/capture-candidates').set('Authorization', bearer(ADMIN));
      expect(forI2.body.current).toBe(null);
      expect(forI2.body.candidates).toEqual(['W2']); // W1 usado por __i1__ → excluído; W3 é t2
      const forI1 = await request(app).get('/api/instances/__i1__/capture-candidates').set('Authorization', bearer(ADMIN));
      expect(forI1.body.current).toBe('W1');
      expect(forI1.body.candidates.sort()).toEqual(['W1', 'W2']); // o próprio W1 permanece
    });
  });
  it('usuário comum não vê candidatos → 403', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/instances/__i1__/capture-candidates').set('Authorization', bearer(USER1));
      expect(r.status).toBe(403);
    });
  });
  it('candidatos de instância de outro tenant → 404', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/instances/__i3__/capture-candidates').set('Authorization', bearer(ADMIN));
      expect(r.status).toBe(404);
    });
  });
});
