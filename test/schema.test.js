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

describe('dono de instância + membros de equipe (Fase 3)', () => {
  it('sentinela_instances tem owner_user_id NOT NULL com FK para users', async () => {
    const [cols] = await pool.query(
      `SELECT IS_NULLABLE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sentinela_instances' AND COLUMN_NAME='owner_user_id'`);
    expect(cols.length).toBe(1);
    expect(cols[0].IS_NULLABLE).toBe('NO');
    const [fk] = await pool.query(
      `SELECT REFERENCED_TABLE_NAME rt FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sentinela_instances' AND COLUMN_NAME='owner_user_id' AND REFERENCED_TABLE_NAME IS NOT NULL`);
    expect(fk[0]?.rt).toBe('users');
  });
  it('tabela team_users existe com PK (team_id, user_id)', async () => {
    expect(await tableExists('team_users')).toBe(true);
    const [pk] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='team_users' AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX`);
    expect(pk.map((r) => r.COLUMN_NAME)).toEqual(['team_id', 'user_id']);
  });
});

describe('índices de performance', () => {
  it('contacts.idx_contacts_tenant_phone e chats.idx_chats_tenant_title existem', async () => {
    expect(await indexExists('contacts','idx_contacts_tenant_phone')).toBe(true);
    expect(await indexExists('chats','idx_chats_tenant_title')).toBe(true);
  });
});

describe('identificação de contatos (Fase 4)', () => {
  it('contact_types existe com colunas esperadas e UNIQUE (tenant_id, id)', async () => {
    expect(await tableExists('contact_types')).toBe(true);
    expect(await colNames('contact_types')).toEqual(expect.arrayContaining(
      ['id', 'tenant_id', 'name', 'color', 'created_at', 'updated_at']));
    expect(await indexExists('contact_types', 'uq_ctype_tenant_id')).toBe(true);
  });
  it('contacts ganhou as colunas de identificação', async () => {
    expect(await colNames('contacts')).toEqual(expect.arrayContaining(
      ['display_name', 'contact_type_id', 'linked_user_id', 'identification_source', 'identified_by_user_id', 'identified_at']));
  });
  it('fk_contact_type é COMPOSTA (tenant_id, contact_type_id) → contact_types (tenant-safe)', async () => {
    const [rows] = await pool.query(
      `SELECT COLUMN_NAME, REFERENCED_TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='contacts' AND CONSTRAINT_NAME='fk_contact_type'
       ORDER BY ORDINAL_POSITION`);
    expect(rows.map((r) => r.COLUMN_NAME)).toEqual(['tenant_id', 'contact_type_id']);
    expect(rows.every((r) => r.REFERENCED_TABLE_NAME === 'contact_types')).toBe(true);
  });
});

describe('auditoria — access_logs (Fase 6)', () => {
  it('access_logs existe com colunas e índices esperados', async () => {
    expect(await tableExists('access_logs')).toBe(true);
    expect(await colNames('access_logs')).toEqual(expect.arrayContaining(
      ['id', 'tenant_id', 'actor_user_id', 'actor_role', 'action', 'resource', 'resource_id', 'status', 'ip', 'metadata', 'created_at']));
    expect(await indexExists('access_logs', 'idx_alog_tenant_created')).toBe(true);
  });
  it('FKs: tenant CASCADE e ator SET NULL', async () => {
    const [rows] = await pool.query(
      `SELECT rc.CONSTRAINT_NAME n, rc.DELETE_RULE d FROM information_schema.REFERENTIAL_CONSTRAINTS rc
       WHERE rc.CONSTRAINT_SCHEMA=DATABASE() AND rc.TABLE_NAME='access_logs'`);
    const byName = Object.fromEntries(rows.map((r) => [r.n, r.d]));
    expect(byName.fk_alog_tenant).toBe('CASCADE');
    expect(byName.fk_alog_actor).toBe('SET NULL');
  });
});
