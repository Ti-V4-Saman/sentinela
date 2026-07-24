import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { getPool, applyMigrations, withTx } from './helpers/db.js';
import { signToken } from '../server/auth/jwt.js';
import { authenticate } from '../server/middleware/authenticate.js';
import { createUsersRouter } from '../server/routes/users.js';

function makeApp(conn) {
  const a = express();
  a.use(express.json());
  a.use('/api/users', authenticate, createUsersRouter(conn));
  return a;
}
const bearer = (p) => `Bearer ${signToken(p)}`;

// 2 tenants; superadmin (SA), admin do T1 (AD1), admin do T2 (AD2), um usuario do T1.
async function seed(conn) {
  await conn.query("INSERT INTO tenants (id,name) VALUES (900001,'T1'),(900002,'T2')");
  await conn.query(`INSERT INTO users (id,tenant_id,name,email,password_hash,role,status) VALUES
    (900001,NULL,'SA','sa@__test__','x','superadmin','active'),
    (900010,900001,'AD1','ad1@__test__','x','admin','active'),
    (900020,900002,'AD2','ad2@__test__','x','admin','active'),
    (900011,900001,'U1','u1@__test__','x','usuario','active')`);
}

beforeAll(async () => { process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'; await applyMigrations(); });
afterAll(() => getPool().end());

const SA = { userId: 900001, tenantId: null, role: 'superadmin' };
const AD1 = { userId: 900010, tenantId: 900001, role: 'admin' };
const AD2 = { userId: 900020, tenantId: 900002, role: 'admin' };

describe('CRUD /api/users (RBAC do banco, transação com rollback)', () => {
  it('admin cria usuario no PRÓPRIO tenant e senha nunca é retornada', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const app = makeApp(conn);
      const res = await request(app).post('/api/users').set('Authorization', bearer(AD1))
        .send({ name: 'Novo', email: 'novo@__test__', password: 'segredo123', role: 'gestor' });
      expect(res.status).toBe(201);
      expect(res.body.tenantId).toBe(900001);
      expect(res.body.role).toBe('gestor');
      expect(res.body).not.toHaveProperty('password_hash');
      expect(res.body).not.toHaveProperty('password');
    });
  });

  it('admin NÃO pode criar superadmin (403)', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const app = makeApp(conn);
      const res = await request(app).post('/api/users').set('Authorization', bearer(AD1))
        .send({ name: 'x', email: 'x@__test__', password: 'p12345678', role: 'superadmin' });
      expect(res.status).toBe(403);
    });
  });

  it('admin ignora tenantId do body — usuário fica no tenant do admin', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const app = makeApp(conn);
      const res = await request(app).post('/api/users').set('Authorization', bearer(AD1))
        .send({ name: 'x', email: 'x2@__test__', password: 'p12345678', role: 'usuario', tenantId: 900002 });
      expect(res.status).toBe(201);
      expect(res.body.tenantId).toBe(900001); // não 900002
    });
  });

  it('admin do T1 só lista usuários do T1 (não vê os do T2 nem superadmin)', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const app = makeApp(conn);
      const res = await request(app).get('/api/users').set('Authorization', bearer(AD1));
      const tenants = new Set(res.body.map((u) => u.tenantId));
      expect([...tenants]).toEqual([900001]);
    });
  });

  it('admin do T1 recebe 404 (não 403) ao editar usuário do T2 — sem oráculo', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const app = makeApp(conn);
      // 900020 é admin do T2
      const res = await request(app).put('/api/users/900020').set('Authorization', bearer(AD1)).send({ name: 'z' });
      expect(res.status).toBe(404);
    });
  });

  it('superadmin cria admin em qualquer tenant e superadmin sem tenant', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const app = makeApp(conn);
      const a = await request(app).post('/api/users').set('Authorization', bearer(SA))
        .send({ name: 'AdminT2', email: 'at2@__test__', password: 'p12345678', role: 'admin', tenantId: 900002 });
      expect(a.status).toBe(201);
      expect(a.body.tenantId).toBe(900002);
      const s = await request(app).post('/api/users').set('Authorization', bearer(SA))
        .send({ name: 'SA2', email: 'sa2@__test__', password: 'p12345678', role: 'superadmin' });
      expect(s.status).toBe(201);
      expect(s.body.tenantId).toBe(null);
    });
  });

  it('email duplicado → 409', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const app = makeApp(conn);
      const res = await request(app).post('/api/users').set('Authorization', bearer(AD1))
        .send({ name: 'dup', email: 'u1@__test__', password: 'p12345678', role: 'usuario' });
      expect(res.status).toBe(409);
    });
  });

  it('admin não pode remover a própria conta (400)', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const app = makeApp(conn);
      const res = await request(app).delete('/api/users/900010').set('Authorization', bearer(AD1));
      expect(res.status).toBe(400);
    });
  });

  it('admin remove usuário do próprio tenant (200)', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const app = makeApp(conn);
      const res = await request(app).delete('/api/users/900011').set('Authorization', bearer(AD1));
      expect(res.status).toBe(200);
    });
  });

  it('usuario (read-only) não acessa /api/users (403)', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const app = makeApp(conn);
      const res = await request(app).get('/api/users')
        .set('Authorization', bearer({ userId: 900011, tenantId: 900001, role: 'usuario' }));
      expect(res.status).toBe(403);
    });
  });
});
