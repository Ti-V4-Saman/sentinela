import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { getPool, applyMigrations, withTx } from './helpers/db.js';
import { signToken } from '../server/auth/jwt.js';
import { authenticate } from '../server/middleware/authenticate.js';
import { createProfileRouter } from '../server/routes/profile.js';
import { hashPassword, verifyPassword } from '../server/auth/password.js';

function makeApp(conn) {
  const a = express();
  a.use(express.json());
  a.use('/api/users/me', authenticate, createProfileRouter(conn));
  return a;
}
const bearer = (p) => `Bearer ${signToken(p)}`;

// Usuário A (900011, usuario) e B (900012, usuario) no mesmo tenant.
async function seed(conn) {
  await conn.query("INSERT INTO tenants (id,name) VALUES (900001,'T1')");
  const h = await hashPassword('senhaAntiga1');
  await conn.query(
    `INSERT INTO users (id,tenant_id,name,email,password_hash,role,status) VALUES
     (900011,900001,'Fulano','a@__test__',?,'usuario','active'),
     (900012,900001,'Beltrano','b@__test__',?,'usuario','active')`, [h, h]);
}
const A = { userId: 900011, tenantId: 900001, role: 'usuario' };

beforeAll(async () => { process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'; await applyMigrations(); });
afterAll(() => getPool().end());

describe('PATCH /api/users/me (auto-atualização, transação com rollback)', () => {
  it('atualiza o próprio nome', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const res = await request(makeApp(conn)).patch('/api/users/me').set('Authorization', bearer(A)).send({ name: 'Fulano da Silva' });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Fulano da Silva');
      const [[u]] = await conn.query('SELECT name FROM users WHERE id=900011');
      expect(u.name).toBe('Fulano da Silva');
    });
  });

  it('atualiza a própria senha (novo hash funciona)', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const res = await request(makeApp(conn)).patch('/api/users/me').set('Authorization', bearer(A)).send({ password: 'novaSenha123' });
      expect(res.status).toBe(200);
      const [[u]] = await conn.query('SELECT password_hash FROM users WHERE id=900011');
      expect(await verifyPassword('novaSenha123', u.password_hash)).toBe(true);
    });
  });

  it('IGNORA email/role/tenant_id enviados no corpo', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const res = await request(makeApp(conn)).patch('/api/users/me').set('Authorization', bearer(A))
        .send({ name: 'Novo Nome', email: 'hack@x', role: 'superadmin', tenantId: 999 });
      expect(res.status).toBe(200);
      const [[u]] = await conn.query('SELECT email, role, tenant_id FROM users WHERE id=900011');
      expect(u.email).toBe('a@__test__');   // inalterado
      expect(u.role).toBe('usuario');        // inalterado
      expect(u.tenant_id).toBe(900001);      // inalterado
    });
  });

  it('id no corpo é ignorado — só o usuário do JWT é alterado', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      await request(makeApp(conn)).patch('/api/users/me').set('Authorization', bearer(A)).send({ id: 900012, name: 'Invadido' });
      const [[a]] = await conn.query('SELECT name FROM users WHERE id=900011');
      const [[b]] = await conn.query('SELECT name FROM users WHERE id=900012');
      expect(a.name).toBe('Invadido');       // o próprio usuário mudou
      expect(b.name).toBe('Beltrano');       // o outro NÃO
    });
  });

  it('rejeita senha com menos de 8 caracteres (400)', async () => {
    await withTx(async (conn) => {
      await seed(conn);
      const res = await request(makeApp(conn)).patch('/api/users/me').set('Authorization', bearer(A)).send({ password: 'curta' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/8 caracteres/);
    });
  });

  it('sem token → 401', async () => {
    await withTx(async (conn) => {
      const res = await request(makeApp(conn)).patch('/api/users/me').send({ name: 'x' });
      expect(res.status).toBe(401);
    });
  });
});
