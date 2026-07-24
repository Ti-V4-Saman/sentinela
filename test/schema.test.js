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

  it('messages tem as colunas esperadas', async () => {
    const cols = (await columns('messages')).map(c => c.COLUMN_NAME);
    expect(cols).toEqual(expect.arrayContaining(
      ['id','chat_id','contact_id','text','type','from_me','from_internal','timestamp','wid']));
  });
});

async function tableExists(name) {
  const [rows] = await pool.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?`, [name]);
  return rows.length > 0;
}
async function colNames(table) {
  return (await columns(table)).map(c => c.COLUMN_NAME);
}
async function pkCols(table) {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME='PRIMARY'
     ORDER BY SEQ_IN_INDEX`, [table]);
  return rows.map(r => r.COLUMN_NAME);
}
async function indexExists(table, indexName) {
  const [rows] = await pool.query(
    `SELECT INDEX_NAME FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=?`, [table, indexName]);
  return rows.length > 0;
}

describe('tenants', () => {
  it('existe com colunas esperadas', async () => {
    expect(await colNames('tenants')).toEqual(expect.arrayContaining(
      ['id','name','status','created_at','updated_at']));
  });
});

describe('users', () => {
  it('tem colunas e email único', async () => {
    expect(await colNames('users')).toEqual(expect.arrayContaining(
      ['id','tenant_id','name','email','password_hash','role','status']));
    const [idx] = await pool.query(
      `SELECT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='email' AND NON_UNIQUE=0`);
    expect(idx.length).toBeGreaterThan(0);
  });
});

describe('teams e junções', () => {
  it('cria teams, team_managers, team_instances, user_instances', async () => {
    for (const t of ['teams','team_managers','team_instances','user_instances']) {
      expect(await tableExists(t)).toBe(true);
    }
  });
});

describe('tenant_id em instances', () => {
  it('sentinela_instances e instances têm tenant_id', async () => {
    expect(await colNames('sentinela_instances')).toContain('tenant_id');
    expect(await colNames('instances')).toContain('tenant_id');
  });
});

describe('tenant-scoped data tables', () => {
  it('chats/contacts/messages têm PK (tenant_id, id)', async () => {
    expect(await pkCols('chats')).toEqual(['tenant_id','id']);
    expect(await pkCols('contacts')).toEqual(['tenant_id','id']);
    expect(await pkCols('messages')).toEqual(['tenant_id','id']);
  });
  it('messages, mentions, chats, contacts têm tenant_id', async () => {
    for (const t of ['messages','mentions','chats','contacts']) {
      expect(await colNames(t)).toContain('tenant_id');
    }
  });
  it('recria FK composta messages->chats (tenant_id, chat_id)', async () => {
    const [fk] = await pool.query(
      `SELECT CONSTRAINT_NAME, COUNT(*) n FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='messages'
         AND REFERENCED_TABLE_NAME='chats' GROUP BY CONSTRAINT_NAME`);
    expect(fk.some(r => Number(r.n) === 2)).toBe(true);
  });
  it('recria FK composta mentions->messages (tenant_id, message_id)', async () => {
    const [fk] = await pool.query(
      `SELECT CONSTRAINT_NAME, COUNT(*) n FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mentions'
         AND REFERENCED_TABLE_NAME='messages' GROUP BY CONSTRAINT_NAME`);
    expect(fk.some(r => Number(r.n) === 2)).toBe(true);
  });
});

describe('índices de performance', () => {
  it('contacts.idx_contacts_tenant_phone e chats.idx_chats_tenant_title existem', async () => {
    expect(await indexExists('contacts','idx_contacts_tenant_phone')).toBe(true);
    expect(await indexExists('chats','idx_chats_tenant_title')).toBe(true);
  });
});
