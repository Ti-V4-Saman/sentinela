import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, applyMigrations } from './helpers/db.js';

const pool = getPool();
beforeAll(async () => { await applyMigrations(); });
afterAll(() => pool.end());

async function columns(table) {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME, COLUMN_KEY FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [table]);
  return rows;
}

describe('baseline schema', () => {
  it('cria as 6 tabelas base', async () => {
    const [rows] = await pool.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`);
    const names = rows.map(r => r.TABLE_NAME);
    for (const t of ['chats','contacts','instances','sentinela_instances','messages','mentions']) {
      expect(names).toContain(t);
    }
  });

  it('messages tem PK id e colunas esperadas', async () => {
    const cols = (await columns('messages')).map(c => c.COLUMN_NAME);
    expect(cols).toEqual(expect.arrayContaining(
      ['id','chat_id','contact_id','text','type','from_me','from_internal','timestamp','wid']));
  });
});
