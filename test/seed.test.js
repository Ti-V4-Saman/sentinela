import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, applyMigrations, withTx } from './helpers/db.js';
import { hashPassword } from '../server/auth/password.js';

beforeAll(async () => { await applyMigrations(); });
afterAll(() => getPool().end());

describe('seed bootstrap (em transação com rollback)', () => {
  it('cria tenant e superadmin', async () => {
    await withTx(async (conn) => {
      await conn.query("INSERT IGNORE INTO tenants (name) VALUES ('__TEST_V4Company__')");
      const hash = await hashPassword('x');
      await conn.query(
        `INSERT INTO users (tenant_id, name, email, password_hash, role, status)
         VALUES (NULL, 'Superadmin', 'sa@__test__', ?, 'superadmin', 'active')`, [hash]);
      const [t] = await conn.query("SELECT COUNT(*) c FROM tenants WHERE name='__TEST_V4Company__'");
      const [u] = await conn.query("SELECT COUNT(*) c FROM users WHERE role='superadmin' AND email='sa@__test__'");
      expect(t[0].c).toBe(1);
      expect(u[0].c).toBe(1);
    });
  });
});
