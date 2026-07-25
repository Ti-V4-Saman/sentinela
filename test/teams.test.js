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
const AD1 = { userId: 900050, tenantId: 900001, role: 'admin' };

// t1: admin 900050, gestor 900040, usuario 900011 (dono __i1__/'A'), usuario 900012 (dono __i2__/'B')
// t2: usuario 900013 (dono __i3__)
async function seed(conn) {
  await conn.query("INSERT INTO tenants (id,name) VALUES (900001,'T1'),(900002,'T2')");
  await conn.query(`INSERT INTO users (id,tenant_id,name,email,password_hash,role,status) VALUES
    (900050,900001,'A1','a1@__test__','x','admin','active'),
    (900040,900001,'G1','g1@__test__','x','gestor','active'),
    (900011,900001,'U1','u1@__test__','x','usuario','active'),
    (900012,900001,'U2','u2@__test__','x','usuario','active'),
    (900013,900002,'U3','u3@__test__','x','usuario','active')`);
  await conn.query(`INSERT INTO sentinela_instances (id,tenant_id,owner_user_id,name,token) VALUES
    ('__i1__',900001,900011,'A','t1'),
    ('__i2__',900001,900012,'B','t2'),
    ('__i3__',900002,900013,'C','t3')`);
}
async function createTeam(app) {
  const r = await request(app).post('/api/teams').set('Authorization', bearer(AD1)).send({ name: 'Eq A' });
  return r.body.id;
}
const ids = (arr) => arr.map((x) => x.id).sort();

beforeAll(async () => { process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'; await applyMigrations(); });
afterAll(() => getPool().end());

describe('CRUD /api/teams + membros (usuários) e números derivados', () => {
  it('admin cria equipe no próprio tenant; lista traz contagens', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const app = makeApp(conn);
      const created = await request(app).post('/api/teams').set('Authorization', bearer(AD1)).send({ name: 'Eq A' });
      expect(created.status).toBe(201);
      expect(created.body.tenantId).toBe(900001);
      const list = await request(app).get('/api/teams').set('Authorization', bearer(AD1));
      const t = list.body.find((x) => x.id === created.body.id);
      expect(t.userCount).toBe(0);
      expect(t.managerCount).toBe(0);
    });
  });

  it('vincular usuário-membro traz as instâncias dele (derivadas)', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const app = makeApp(conn);
      const teamId = await createTeam(app);
      const ok = await request(app).post(`/api/teams/${teamId}/users`).set('Authorization', bearer(AD1)).send({ userId: 900011 });
      expect(ok.status).toBe(201);
      const derived = await request(app).get(`/api/teams/${teamId}/instances`).set('Authorization', bearer(AD1));
      expect(ids(derived.body)).toEqual(['__i1__']);
    });
  });

  it('números derivados = união dos membros; remover membro remove os dele', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const app = makeApp(conn);
      const teamId = await createTeam(app);
      await request(app).post(`/api/teams/${teamId}/users`).set('Authorization', bearer(AD1)).send({ userId: 900011 });
      await request(app).post(`/api/teams/${teamId}/users`).set('Authorization', bearer(AD1)).send({ userId: 900012 });
      let derived = await request(app).get(`/api/teams/${teamId}/instances`).set('Authorization', bearer(AD1));
      expect(ids(derived.body)).toEqual(['__i1__', '__i2__']);
      await request(app).delete(`/api/teams/${teamId}/users/900011`).set('Authorization', bearer(AD1));
      derived = await request(app).get(`/api/teams/${teamId}/instances`).set('Authorization', bearer(AD1));
      expect(ids(derived.body)).toEqual(['__i2__']);
    });
  });

  it('só usuário com papel "usuário" pode ser membro; outro tenant → 404', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const app = makeApp(conn);
      const teamId = await createTeam(app);
      const gestorAsMember = await request(app).post(`/api/teams/${teamId}/users`).set('Authorization', bearer(AD1)).send({ userId: 900040 });
      expect(gestorAsMember.status).toBe(400);
      const crossTenant = await request(app).post(`/api/teams/${teamId}/users`).set('Authorization', bearer(AD1)).send({ userId: 900013 });
      expect(crossTenant.status).toBe(404);
    });
  });

  it('gestores continuam sendo vínculo separado (team_managers)', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const app = makeApp(conn);
      const teamId = await createTeam(app);
      const ok = await request(app).post(`/api/teams/${teamId}/managers`).set('Authorization', bearer(AD1)).send({ userId: 900040 });
      expect(ok.status).toBe(201);
      const notGestor = await request(app).post(`/api/teams/${teamId}/managers`).set('Authorization', bearer(AD1)).send({ userId: 900011 });
      expect(notGestor.status).toBe(400);
      const managers = await request(app).get(`/api/teams/${teamId}/managers`).set('Authorization', bearer(AD1));
      expect(managers.body.map((m) => m.id)).toEqual([900040]);
    });
  });

  it('gestor (read-only) não gerencia equipes (403)', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const res = await request(makeApp(conn)).get('/api/teams')
        .set('Authorization', bearer({ userId: 900040, tenantId: 900001, role: 'gestor' }));
      expect(res.status).toBe(403);
    });
  });

  it('remover equipe limpa membros e gestores (CASCADE)', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const app = makeApp(conn);
      const teamId = await createTeam(app);
      await request(app).post(`/api/teams/${teamId}/users`).set('Authorization', bearer(AD1)).send({ userId: 900011 });
      await request(app).post(`/api/teams/${teamId}/managers`).set('Authorization', bearer(AD1)).send({ userId: 900040 });
      const del = await request(app).delete(`/api/teams/${teamId}`).set('Authorization', bearer(AD1));
      expect(del.status).toBe(200);
      const [[tu]] = await conn.query('SELECT COUNT(*) n FROM team_users WHERE team_id = ?', [teamId]);
      const [[tm]] = await conn.query('SELECT COUNT(*) n FROM team_managers WHERE team_id = ?', [teamId]);
      expect(tu.n).toBe(0);
      expect(tm.n).toBe(0);
    });
  });
});
