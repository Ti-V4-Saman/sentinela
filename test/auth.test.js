import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { hashPassword, verifyPassword } from '../server/auth/password.js';
import { signToken, verifyToken } from '../server/auth/jwt.js';
import { authenticate } from '../server/middleware/authenticate.js';
import { getPool, applyMigrations, withTx } from './helpers/db.js';
import { createAuthRouter } from '../server/routes/auth.js';

describe('password', () => {
  it('faz hash e verifica', async () => {
    const h = await hashPassword('s3nha-forte');
    expect(h).not.toBe('s3nha-forte');
    expect(await verifyPassword('s3nha-forte', h)).toBe(true);
    expect(await verifyPassword('errada', h)).toBe(false);
  });
});

describe('jwt', () => {
  it('assina e verifica payload', () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    const t = signToken({ userId: 1, tenantId: 5, role: 'admin' });
    const p = verifyToken(t);
    expect(p.userId).toBe(1);
    expect(p.tenantId).toBe(5);
    expect(p.role).toBe('admin');
  });
  it('rejeita token adulterado', () => {
    expect(() => verifyToken('lixo.invalido.token')).toThrow();
  });
});

function mockRes() {
  return {
    statusCode: 0, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

describe('authenticate', () => {
  it('popula req.auth com Bearer válido', () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    const token = signToken({ userId: 7, tenantId: 2, role: 'gestor' });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes(); let called = false;
    authenticate(req, res, () => { called = true; });
    expect(called).toBe(true);
    expect(req.auth).toEqual(expect.objectContaining({ userId: 7, tenantId: 2, role: 'gestor' }));
  });
  it('401 sem header', () => {
    const req = { headers: {} }; const res = mockRes();
    authenticate(req, res, () => {});
    expect(res.statusCode).toBe(401);
  });
});

function appWith(conn) {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', createAuthRouter(conn));
  return app;
}

describe('POST /api/auth/login (em transação com rollback)', () => {
  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    await applyMigrations();
  });
  afterAll(() => getPool().end());

  it('loga com credencial válida', async () => {
    await withTx(async (conn) => {
      await conn.query("INSERT INTO tenants (id, name) VALUES (900001,'T1')");
      const hash = await hashPassword('senha123');
      await conn.query(
        "INSERT INTO users (tenant_id, name, email, password_hash, role) VALUES (900001,'Admin','a@__test__',?, 'admin')",
        [hash]);
      const res = await request(appWith(conn)).post('/api/auth/login')
        .send({ email: 'a@__test__', password: 'senha123' });
      expect(res.status).toBe(200);
      expect(res.body.token).toBeTruthy();
      expect(res.body.user.role).toBe('admin');
    });
  });
  it('401 com senha errada', async () => {
    await withTx(async (conn) => {
      await conn.query("INSERT INTO tenants (id, name) VALUES (900001,'T1')");
      const hash = await hashPassword('senha123');
      await conn.query(
        "INSERT INTO users (tenant_id, name, email, password_hash, role) VALUES (900001,'Admin','a@__test__',?, 'admin')",
        [hash]);
      const res = await request(appWith(conn)).post('/api/auth/login')
        .send({ email: 'a@__test__', password: 'errada' });
      expect(res.status).toBe(401);
    });
  });
});
