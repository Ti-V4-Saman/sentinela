import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getPool, applyMigrations } from './helpers/db.js';
import { createApp } from '../server/index.js';

describe('app wiring', () => {
  let app;
  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    await applyMigrations();
    app = createApp(getPool());
  });
  afterAll(() => getPool().end());

  it('login é público, instances exige auth', async () => {
    const login = await request(app).post('/api/auth/login').send({ email: 'x', password: 'y' });
    expect([400, 401]).toContain(login.status); // rota existe, sem X-Sentinela-Key
    const inst = await request(app).get('/api/instances');
    expect(inst.status).toBe(401);
  });
});
