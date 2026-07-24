import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { getPool, applyMigrations, withTx } from './helpers/db.js';
import { signToken } from '../server/auth/jwt.js';
import { authenticate } from '../server/middleware/authenticate.js';
import { createTenantsRouter } from '../server/routes/tenants.js';

function makeApp(conn) {
  const a = express();
  a.use(express.json());
  a.use('/api/tenants', authenticate, createTenantsRouter(conn));
  return a;
}
const bearer = (p) => `Bearer ${signToken(p)}`;

// superadmin ativo (900001), admin ativo (900002), superadmin desativado (900003).
async function seedUsers(conn) {
  await conn.query("INSERT INTO tenants (id,name) VALUES (900001,'T1')");
  await conn.query(`INSERT INTO users (id,tenant_id,name,email,password_hash,role,status) VALUES
    (900001,NULL,'SA','sa@__test__','x','superadmin','active'),
    (900002,900001,'AD','ad@__test__','x','admin','active'),
    (900003,NULL,'SAd','sad@__test__','x','superadmin','disabled')`);
}

beforeAll(async () => { process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'; await applyMigrations(); });
afterAll(() => getPool().end());

describe('CRUD /api/tenants (superadmin, RBAC do banco, transação com rollback)', () => {
  it('superadmin cria, lista, atualiza e remove tenant', async () => {
    await withTx(async (conn) => {
      await seedUsers(conn);
      const app = makeApp(conn);
      const sa = bearer({ userId: 900001, tenantId: null, role: 'superadmin' });

      const created = await request(app).post('/api/tenants').set('Authorization', sa).send({ name: 'Cliente X' });
      expect(created.status).toBe(201);
      expect(created.body.name).toBe('Cliente X');
      const id = created.body.id;

      const list = await request(app).get('/api/tenants').set('Authorization', sa);
      expect(list.status).toBe(200);
      expect(list.body.some((t) => t.id === id)).toBe(true);

      const upd = await request(app).put(`/api/tenants/${id}`).set('Authorization', sa).send({ status: 'suspended' });
      expect(upd.status).toBe(200);
      expect(upd.body.status).toBe('suspended');

      const del = await request(app).delete(`/api/tenants/${id}`).set('Authorization', sa);
      expect(del.status).toBe(200);
    });
  });

  it('admin não pode gerenciar tenants (403)', async () => {
    await withTx(async (conn) => {
      await seedUsers(conn);
      const app = makeApp(conn);
      const ad = bearer({ userId: 900002, tenantId: 900001, role: 'admin' });
      expect((await request(app).get('/api/tenants').set('Authorization', ad)).status).toBe(403);
      expect((await request(app).post('/api/tenants').set('Authorization', ad).send({ name: 'y' })).status).toBe(403);
    });
  });

  it('admin com token forjado de superadmin é barrado pelo papel do banco (403)', async () => {
    await withTx(async (conn) => {
      await seedUsers(conn);
      const app = makeApp(conn);
      const forged = bearer({ userId: 900002, tenantId: 900001, role: 'superadmin' });
      expect((await request(app).get('/api/tenants').set('Authorization', forged)).status).toBe(403);
    });
  });

  it('superadmin desativado → 401', async () => {
    await withTx(async (conn) => {
      await seedUsers(conn);
      const app = makeApp(conn);
      const dis = bearer({ userId: 900003, tenantId: null, role: 'superadmin' });
      expect((await request(app).get('/api/tenants').set('Authorization', dis)).status).toBe(401);
    });
  });

  it('nome duplicado → 409', async () => {
    await withTx(async (conn) => {
      await seedUsers(conn);
      const app = makeApp(conn);
      const sa = bearer({ userId: 900001, tenantId: null, role: 'superadmin' });
      await request(app).post('/api/tenants').set('Authorization', sa).send({ name: 'Dup' });
      const again = await request(app).post('/api/tenants').set('Authorization', sa).send({ name: 'Dup' });
      expect(again.status).toBe(409);
    });
  });

  it('remover tenant com instância vinculada → 409 (FK RESTRICT)', async () => {
    await withTx(async (conn) => {
      await seedUsers(conn);
      const app = makeApp(conn);
      const sa = bearer({ userId: 900001, tenantId: null, role: 'superadmin' });
      await conn.query("INSERT INTO sentinela_instances (id,tenant_id,name,token) VALUES ('__t_del__',900001,'X','tk')");
      const del = await request(app).delete('/api/tenants/900001').set('Authorization', sa);
      expect(del.status).toBe(409);
    });
  });

  it('sem token → 401', async () => {
    await withTx(async (conn) => {
      const app = makeApp(conn);
      expect((await request(app).get('/api/tenants')).status).toBe(401);
    });
  });
});
