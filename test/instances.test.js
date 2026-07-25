import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { getPool, applyMigrations, withTx } from './helpers/db.js';
import { signToken } from '../server/auth/jwt.js';
import { authenticate } from '../server/middleware/authenticate.js';
import { createInstancesRouter } from '../server/routes/instances.js';

function makeApp(conn) {
  const a = express();
  a.use(express.json());
  a.use('/api/instances', authenticate, createInstancesRouter(conn));
  return a;
}
const bearer = (p) => `Bearer ${signToken(p)}`;

// t1: admin 900050, usuario 900011 (dono __t_i1__), usuario 900012 (dono __t_i2__)
// t2: admin 900060, usuario 900013 (dono __t_i3__)
async function seed(conn) {
  await conn.query("INSERT INTO tenants (id,name) VALUES (900001,'T1'),(900002,'T2')");
  await conn.query(`INSERT INTO users (id,tenant_id,name,email,password_hash,role,status) VALUES
    (900050,900001,'A1','a1@__test__','x','admin','active'),
    (900011,900001,'U1','u1@__test__','x','usuario','active'),
    (900012,900001,'U2','u2@__test__','x','usuario','active'),
    (900060,900002,'A2','a2@__test__','x','admin','active'),
    (900013,900002,'U3','u3@__test__','x','usuario','active')`);
  await conn.query(`INSERT INTO sentinela_instances (id,tenant_id,owner_user_id,name,token) VALUES
    ('__t_i1__',900001,900011,'A','t1'),
    ('__t_i2__',900001,900012,'B','t2'),
    ('__t_i3__',900002,900013,'C','t3')`);
}

beforeAll(async () => { process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'; await applyMigrations(); });
afterAll(() => getPool().end());

describe('POST /api/instances (dono automático)', () => {
  it('usuário cria a própria instância — owner_user_id = ele, tenant = dele', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const res = await request(makeApp(conn)).post('/api/instances')
        .set('Authorization', bearer({ userId: 900011, tenantId: 900001, role: 'usuario' }))
        .send({ id: '__new_i__', name: 'Nova', token: 'tkn' });
      expect(res.status).toBe(201);
      expect(res.body.ownerUserId).toBe(900011);
      expect(res.body.tenantId).toBe(900001);
    });
  });
  it('superadmin não pode criar instância (sem cliente para ser dono) → 403', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const res = await request(makeApp(conn)).post('/api/instances')
        .set('Authorization', bearer({ userId: 900088, tenantId: null, role: 'superadmin' }))
        .send({ id: '__x__', name: 'X', token: 't' });
      expect(res.status).toBe(403);
    });
  });
});

describe('GET /api/instances (visibilidade por dono)', () => {
  it('admin do t1 vê as duas do t1, não a do t2', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const res = await request(makeApp(conn)).get('/api/instances')
        .set('Authorization', bearer({ userId: 900050, tenantId: 900001, role: 'admin' }));
      expect(res.body.map((i) => i.id).sort()).toEqual(['__t_i1__', '__t_i2__']);
    });
  });
  it('usuário vê só a própria, com o token (é o dono)', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const res = await request(makeApp(conn)).get('/api/instances')
        .set('Authorization', bearer({ userId: 900011, tenantId: 900001, role: 'usuario' }));
      expect(res.body.map((i) => i.id)).toEqual(['__t_i1__']);
      expect(res.body[0]).toHaveProperty('token');
    });
  });
  it('admin do t2 não vê instâncias do t1', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const res = await request(makeApp(conn)).get('/api/instances')
        .set('Authorization', bearer({ userId: 900060, tenantId: 900002, role: 'admin' }));
      expect(res.body.map((i) => i.id)).toEqual(['__t_i3__']);
    });
  });
  it('sem token → 401', async () => {
    await withTx(async (conn) => {
      expect((await request(makeApp(conn)).get('/api/instances')).status).toBe(401);
    });
  });
});

describe('PUT /api/instances/:id (dono ou admin)', () => {
  it('dono pode editar a própria instância (200)', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const res = await request(makeApp(conn)).put('/api/instances/__t_i1__')
        .set('Authorization', bearer({ userId: 900011, tenantId: 900001, role: 'usuario' }))
        .send({ name: 'Renomeada' });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Renomeada');
    });
  });
  it('usuário NÃO pode editar instância de outro usuário do mesmo tenant (403)', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const res = await request(makeApp(conn)).put('/api/instances/__t_i2__')
        .set('Authorization', bearer({ userId: 900011, tenantId: 900001, role: 'usuario' }))
        .send({ name: 'hack' });
      expect(res.status).toBe(403);
    });
  });
  it('admin edita qualquer instância do próprio tenant (200)', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const res = await request(makeApp(conn)).put('/api/instances/__t_i1__')
        .set('Authorization', bearer({ userId: 900050, tenantId: 900001, role: 'admin' }))
        .send({ name: 'AdminEdit' });
      expect(res.status).toBe(200);
    });
  });
  it('admin recebe 404 ao editar instância de outro tenant (sem oráculo)', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const res = await request(makeApp(conn)).put('/api/instances/__t_i3__')
        .set('Authorization', bearer({ userId: 900050, tenantId: 900001, role: 'admin' }))
        .send({ name: 'x' });
      expect(res.status).toBe(404);
    });
  });
});

describe('DELETE removido (instância nunca é excluída)', () => {
  it('não existe rota DELETE de instância → 404', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const res = await request(makeApp(conn)).delete('/api/instances/__t_i1__')
        .set('Authorization', bearer({ userId: 900050, tenantId: 900001, role: 'admin' }));
      expect(res.status).toBe(404);
    });
  });
});
