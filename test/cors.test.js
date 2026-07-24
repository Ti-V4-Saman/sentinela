import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { corsMiddleware } from '../server/config/cors.js';

function app() {
  const a = express();
  a.use(corsMiddleware);
  a.get('/x', (_req, res) => res.json({ ok: true }));
  return a;
}

describe('cors allowlist', () => {
  it('permite origem listada', async () => {
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    const res = await request(app()).get('/x').set('Origin', 'http://localhost:3000');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });
  it('não ecoa origem não listada', async () => {
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    const res = await request(app()).get('/x').set('Origin', 'https://evil.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
