import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { getPool, applyMigrations, withTx } from './helpers/db.js';
import { signToken } from '../server/auth/jwt.js';
import { authenticate } from '../server/middleware/authenticate.js';
import { createInstancesRouter } from '../server/routes/instances.js';

// App cujo router usa a connection transacional `conn`.
function makeApp(conn) {
  const a = express();
  a.use(express.json());
  a.use('/api/instances', authenticate, createInstancesRouter(conn));
  return a;
}
function bearer(p) { return `Bearer ${signToken(p)}`; }

// Seed com IDs sentinela altos, dentro da transação.
// Usuários atuantes precisam existir e estar 'active' (rotas de mutação recarregam do banco).
async function seed(conn) {
  await conn.query("INSERT INTO tenants (id,name) VALUES (900001,'T1'),(900002,'T2')");
  await conn.query(`INSERT INTO sentinela_instances (id,tenant_id,name,token) VALUES
    ('__t_i1__',900001,'A','t1'),('__t_i2__',900001,'B','t2'),('__t_i3__',900002,'C','t3')`);
  await conn.query(`INSERT INTO users (id,tenant_id,name,email,password_hash,role) VALUES
    (900011,900001,'U','u@__test__','x','usuario'),
    (900010,900001,'G','g@__test__','x','gestor'),
    (900050,900001,'A1','a1@__test__','x','admin'),
    (900060,900002,'A2','a2@__test__','x','admin')`);
  await conn.query("INSERT INTO user_instances (user_id,instance_id) VALUES (900011,'__t_i2__')");
}

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  await applyMigrations();
});
afterAll(() => getPool().end());

describe('GET /api/instances (isolamento, em transação com rollback)', () => {
  it('admin do tenant 900001 vê só as duas instâncias dele', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const res = await request(makeApp(conn)).get('/api/instances')
        .set('Authorization', bearer({ userId: 900050, tenantId: 900001, role: 'admin' }));
      expect(res.status).toBe(200);
      expect(res.body.map(i => i.id).sort()).toEqual(['__t_i1__', '__t_i2__']);
    });
  });
  it('usuario 900011 vê só a própria instância, sem o token (redigido)', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const res = await request(makeApp(conn)).get('/api/instances')
        .set('Authorization', bearer({ userId: 900011, tenantId: 900001, role: 'usuario' }));
      expect(res.body.map(i => i.id)).toEqual(['__t_i2__']);
      expect(res.body[0]).not.toHaveProperty('token');
    });
  });
  it('admin recebe o token da instância (não redigido)', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const res = await request(makeApp(conn)).get('/api/instances')
        .set('Authorization', bearer({ userId: 900050, tenantId: 900001, role: 'admin' }));
      expect(res.body[0]).toHaveProperty('token');
    });
  });
  it('admin do tenant 900002 não vê instâncias do tenant 900001', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const res = await request(makeApp(conn)).get('/api/instances')
        .set('Authorization', bearer({ userId: 900060, tenantId: 900002, role: 'admin' }));
      expect(res.body.map(i => i.id)).toEqual(['__t_i3__']);
    });
  });
  it('sem token → 401', async () => {
    await withTx(async (conn) => {
      const res = await request(makeApp(conn)).get('/api/instances');
      expect(res.status).toBe(401);
    });
  });
});

describe('mutações exigem admin/superadmin', () => {
  it('usuario não pode PUT instância (403)', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const res = await request(makeApp(conn)).put('/api/instances/__t_i2__')
        .set('Authorization', bearer({ userId: 900011, tenantId: 900001, role: 'usuario' }))
        .send({ name: 'hack' });
      expect(res.status).toBe(403);
    });
  });
  it('gestor não pode DELETE instância (403)', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const res = await request(makeApp(conn)).delete('/api/instances/__t_i1__')
        .set('Authorization', bearer({ userId: 900010, tenantId: 900001, role: 'gestor' }));
      expect(res.status).toBe(403);
    });
  });
  it('admin pode PUT dentro do tenant (200)', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const res = await request(makeApp(conn)).put('/api/instances/__t_i1__')
        .set('Authorization', bearer({ userId: 900050, tenantId: 900001, role: 'admin' }))
        .send({ name: 'Renomeada' });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Renomeada');
    });
  });
  it('admin recebe 404 (não 403) ao PUT instância de outro tenant — sem oráculo de existência', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const cross = await request(makeApp(conn)).put('/api/instances/__t_i3__')
        .set('Authorization', bearer({ userId: 900050, tenantId: 900001, role: 'admin' }))
        .send({ name: 'cross-tenant' });
      const missing = await request(makeApp(conn)).put('/api/instances/__does_not_exist__')
        .set('Authorization', bearer({ userId: 900050, tenantId: 900001, role: 'admin' }))
        .send({ name: 'x' });
      // Existência em outro tenant e inexistência devem ser indistinguíveis.
      expect(cross.status).toBe(404);
      expect(missing.status).toBe(404);
    });
  });
  it('admin desativado (status disabled) não pode mutar — 401', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      await conn.query("UPDATE users SET status='disabled' WHERE id=900050");
      const res = await request(makeApp(conn)).put('/api/instances/__t_i1__')
        .set('Authorization', bearer({ userId: 900050, tenantId: 900001, role: 'admin' }))
        .send({ name: 'x' });
      expect(res.status).toBe(401);
    });
  });
  it('usuario com token forjado de admin não consegue mutar (papel recarregado do banco) — 403', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      // Token afirma role=admin, mas no banco 900011 é usuario → deve ser barrado.
      const res = await request(makeApp(conn)).put('/api/instances/__t_i2__')
        .set('Authorization', bearer({ userId: 900011, tenantId: 900001, role: 'admin' }))
        .send({ name: 'x' });
      expect(res.status).toBe(403);
    });
  });
});
