import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { getPool, applyMigrations, withTx } from './helpers/db.js';
import { signToken } from '../server/auth/jwt.js';
import { authenticate } from '../server/middleware/authenticate.js';
import { createTeamsRouter } from '../server/routes/teams.js';

function makeApp(conn) {
  const a = express();
  a.use(express.json());
  a.use('/api/teams', authenticate, createTeamsRouter(conn));
  return a;
}
const bearer = (p) => `Bearer ${signToken(p)}`;
const AD1 = { userId: 900010, tenantId: 900001, role: 'admin' };

// T1 e T2; admin T1 (900010); gestor T1 (900030); usuario T1 (900011);
// gestor T2 (900040); instância T1 (__i1__), instância T2 (__i2__).
async function seed(conn) {
  await conn.query("INSERT INTO tenants (id,name) VALUES (900001,'T1'),(900002,'T2')");
  await conn.query(`INSERT INTO users (id,tenant_id,name,email,password_hash,role,status) VALUES
    (900010,900001,'AD1','ad1@__test__','x','admin','active'),
    (900030,900001,'G1','g1@__test__','x','gestor','active'),
    (900011,900001,'U1','u1@__test__','x','usuario','active'),
    (900040,900002,'G2','g2@__test__','x','gestor','active')`);
  await conn.query(`INSERT INTO sentinela_instances (id,tenant_id,name,token) VALUES
    ('__i1__',900001,'Inst1','tk1'),('__i2__',900002,'Inst2','tk2')`);
}

beforeAll(async () => { process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'; await applyMigrations(); });
afterAll(() => getPool().end());

async function createTeam(app) {
  const res = await request(app).post('/api/teams').set('Authorization', bearer(AD1)).send({ name: 'Equipe A' });
  return res.body.id;
}

describe('CRUD /api/teams + vínculos (transação com rollback)', () => {
  it('admin cria equipe no próprio tenant e lista', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const app = makeApp(conn);
      const created = await request(app).post('/api/teams').set('Authorization', bearer(AD1)).send({ name: 'Equipe A' });
      expect(created.status).toBe(201);
      expect(created.body.tenantId).toBe(900001);
      const list = await request(app).get('/api/teams').set('Authorization', bearer(AD1));
      expect(list.body.map((t) => t.id)).toContain(created.body.id);
    });
  });

  it('vincula instância do mesmo tenant (201) e rejeita instância de outro tenant (404)', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const app = makeApp(conn);
      const teamId = await createTeam(app);
      const ok = await request(app).post(`/api/teams/${teamId}/instances`)
        .set('Authorization', bearer(AD1)).send({ instanceId: '__i1__' });
      expect(ok.status).toBe(201);
      const cross = await request(app).post(`/api/teams/${teamId}/instances`)
        .set('Authorization', bearer(AD1)).send({ instanceId: '__i2__' });
      expect(cross.status).toBe(404);
      const list = await request(app).get(`/api/teams/${teamId}/instances`).set('Authorization', bearer(AD1));
      expect(list.body.map((i) => i.id)).toEqual(['__i1__']);
    });
  });

  it('vínculo de instância duplicado → 409; desvincular → 200', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const app = makeApp(conn);
      const teamId = await createTeam(app);
      await request(app).post(`/api/teams/${teamId}/instances`).set('Authorization', bearer(AD1)).send({ instanceId: '__i1__' });
      const dup = await request(app).post(`/api/teams/${teamId}/instances`).set('Authorization', bearer(AD1)).send({ instanceId: '__i1__' });
      expect(dup.status).toBe(409);
      const del = await request(app).delete(`/api/teams/${teamId}/instances/__i1__`).set('Authorization', bearer(AD1));
      expect(del.status).toBe(200);
    });
  });

  it('vincula gestor do mesmo tenant (201); rejeita usuario não-gestor (400); rejeita gestor de outro tenant (404)', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const app = makeApp(conn);
      const teamId = await createTeam(app);
      const ok = await request(app).post(`/api/teams/${teamId}/managers`).set('Authorization', bearer(AD1)).send({ userId: 900030 });
      expect(ok.status).toBe(201);
      const notGestor = await request(app).post(`/api/teams/${teamId}/managers`).set('Authorization', bearer(AD1)).send({ userId: 900011 });
      expect(notGestor.status).toBe(400);
      const crossTenant = await request(app).post(`/api/teams/${teamId}/managers`).set('Authorization', bearer(AD1)).send({ userId: 900040 });
      expect(crossTenant.status).toBe(404);
      const managers = await request(app).get(`/api/teams/${teamId}/managers`).set('Authorization', bearer(AD1));
      expect(managers.body.map((m) => m.id)).toEqual([900030]);
    });
  });

  it('admin de T2 não enxerga/edita equipe de T1 (404)', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      await conn.query("INSERT INTO users (id,tenant_id,name,email,password_hash,role,status) VALUES (900020,900002,'AD2','ad2@__test__','x','admin','active')");
      const app = makeApp(conn);
      const teamId = await createTeam(app);
      const res = await request(app).put(`/api/teams/${teamId}`)
        .set('Authorization', bearer({ userId: 900020, tenantId: 900002, role: 'admin' })).send({ name: 'z' });
      expect(res.status).toBe(404);
    });
  });

  it('gestor (read-only) não gerencia equipes (403)', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const app = makeApp(conn);
      const res = await request(app).get('/api/teams')
        .set('Authorization', bearer({ userId: 900030, tenantId: 900001, role: 'gestor' }));
      expect(res.status).toBe(403);
    });
  });

  it('remover equipe limpa os vínculos (CASCADE)', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const app = makeApp(conn);
      const teamId = await createTeam(app);
      await request(app).post(`/api/teams/${teamId}/instances`).set('Authorization', bearer(AD1)).send({ instanceId: '__i1__' });
      await request(app).post(`/api/teams/${teamId}/managers`).set('Authorization', bearer(AD1)).send({ userId: 900030 });
      const del = await request(app).delete(`/api/teams/${teamId}`).set('Authorization', bearer(AD1));
      expect(del.status).toBe(200);
      const [[ti]] = await conn.query('SELECT COUNT(*) n FROM team_instances WHERE team_id = ?', [teamId]);
      const [[tm]] = await conn.query('SELECT COUNT(*) n FROM team_managers WHERE team_id = ?', [teamId]);
      expect(ti.n).toBe(0);
      expect(tm.n).toBe(0);
    });
  });
});
