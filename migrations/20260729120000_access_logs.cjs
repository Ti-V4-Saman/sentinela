// Fase 6 — Auditoria: tabela `access_logs`.
//
// Registra eventos de acesso/mutação SEM conteúdo sensível (ver docs/AUDITORIA-LGPD.md):
// nunca guarda texto de mensagem, token, senha, payload de auth nem `capture_wid` cru. `metadata`
// é JSON apenas para metadados NÃO sensíveis (ex.: contadores).
//
// Integridade:
// - tenant_id FK → tenants ON DELETE CASCADE (logs do cliente somem com o cliente — coerente com a
//   exclusão de tenant já cascatear usuários/equipes; e com a política de retenção da LGPD).
// - actor_user_id FK → users ON DELETE SET NULL (preserva o evento mesmo se o usuário for removido).
// - `action` e `resource` são de LISTA FECHADA validada na aplicação (server/audit.js).
//
// ⚠️ ADD/CREATE reconstrói/segura a tabela no MySQL 8 → em produção EXIGE JANELA APROVADA.
// NÃO EXECUTAR EM PRODUÇÃO. Defensiva: valida a DEFINIÇÃO de objetos de mesmo nome (colunas/ordem de
// índice; colunas locais + destino + regras de FK; tipo/nulabilidade de coluna) — incompatível FALHA
// com mensagem explícita; idempotente (cria só o que falta).

const TABLE = 'access_logs';

// ---- Validadores puros (idênticos aos da Fase 4; migrations são autossuficientes) ----
function validateIndexColumns(rows, expectedCols) {
  if (!rows || rows.length === 0) return { exists: false, ok: false };
  const cols = rows.slice().sort((a, b) => Number(a.SEQ_IN_INDEX) - Number(b.SEQ_IN_INDEX)).map((r) => r.COLUMN_NAME);
  const ok = cols.length === expectedCols.length && cols.every((c, i) => c === expectedCols[i]);
  return { exists: true, ok };
}
function validateForeignKey(rows, expected) {
  if (!rows || rows.length === 0) return { exists: false, ok: false };
  const sorted = rows.slice().sort((a, b) => Number(a.ORDINAL_POSITION) - Number(b.ORDINAL_POSITION));
  const cols = sorted.map((r) => r.COLUMN_NAME);
  const refCols = sorted.map((r) => r.REFERENCED_COLUMN_NAME);
  const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const ok = eq(cols, expected.columns)
    && sorted[0].REFERENCED_TABLE_NAME === expected.referencedTable
    && eq(refCols, expected.referencedColumns)
    && sorted[0].DELETE_RULE === expected.onDelete
    && sorted[0].UPDATE_RULE === expected.onUpdate;
  return { exists: true, ok };
}
function validateColumn(row, expected) {
  if (!row) return { exists: false, ok: false };
  const typeOk = String(row.COLUMN_TYPE).toLowerCase() === String(expected.type).toLowerCase();
  const nullOk = (String(row.IS_NULLABLE).toUpperCase() === 'YES') === !!expected.nullable;
  return { exists: true, ok: typeOk && nullOk };
}

const COLUMNS = [
  { name: 'id', type: 'bigint unsigned', nullable: false, ddl: 'id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT' },
  { name: 'tenant_id', type: 'bigint unsigned', nullable: true, ddl: 'tenant_id BIGINT UNSIGNED NULL AFTER id' },
  { name: 'actor_user_id', type: 'bigint unsigned', nullable: true, ddl: 'actor_user_id BIGINT UNSIGNED NULL AFTER tenant_id' },
  { name: 'actor_role', type: 'varchar(20)', nullable: true, ddl: 'actor_role VARCHAR(20) NULL AFTER actor_user_id' },
  { name: 'action', type: 'varchar(48)', nullable: false, ddl: 'action VARCHAR(48) NOT NULL AFTER actor_role' },
  { name: 'resource', type: 'varchar(48)', nullable: false, ddl: 'resource VARCHAR(48) NOT NULL AFTER action' },
  { name: 'resource_id', type: 'varchar(64)', nullable: true, ddl: 'resource_id VARCHAR(64) NULL AFTER resource' },
  { name: 'status', type: 'varchar(16)', nullable: false, ddl: "status VARCHAR(16) NOT NULL DEFAULT 'ok' AFTER resource_id" },
  { name: 'ip', type: 'varchar(45)', nullable: true, ddl: 'ip VARCHAR(45) NULL AFTER status' },
  { name: 'metadata', type: 'json', nullable: true, ddl: 'metadata JSON NULL AFTER ip' },
  { name: 'created_at', type: 'timestamp', nullable: false, ddl: 'created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER metadata' },
];
const INDEXES = [
  { name: 'idx_alog_tenant_created', cols: ['tenant_id', 'created_at'], ddl: 'tenant_id, created_at' },
  { name: 'idx_alog_action', cols: ['action'], ddl: 'action' },
  { name: 'idx_alog_actor', cols: ['actor_user_id'], ddl: 'actor_user_id' },
];
const FKS = [
  { name: 'fk_alog_tenant', ddl: 'FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE ON UPDATE RESTRICT',
    spec: { columns: ['tenant_id'], referencedTable: 'tenants', referencedColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'RESTRICT' } },
  { name: 'fk_alog_actor', ddl: 'FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE RESTRICT',
    spec: { columns: ['actor_user_id'], referencedTable: 'users', referencedColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'RESTRICT' } },
];

async function tableExists(knex, name) {
  const [rows] = await knex.raw('SELECT COUNT(*) AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [name]);
  return rows[0].c > 0;
}
async function columnRow(knex, col) {
  const [rows] = await knex.raw('SELECT COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [TABLE, col]);
  return rows[0];
}
async function indexRows(knex, name) {
  const [rows] = await knex.raw('SELECT COLUMN_NAME, SEQ_IN_INDEX FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? ORDER BY SEQ_IN_INDEX', [TABLE, name]);
  return rows;
}
async function fkRows(knex, name) {
  const [rows] = await knex.raw(
    `SELECT kcu.COLUMN_NAME, kcu.ORDINAL_POSITION, kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME, rc.DELETE_RULE, rc.UPDATE_RULE
     FROM information_schema.KEY_COLUMN_USAGE kcu
     JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
       ON rc.CONSTRAINT_SCHEMA = kcu.TABLE_SCHEMA AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND rc.TABLE_NAME = kcu.TABLE_NAME
     WHERE kcu.TABLE_SCHEMA = DATABASE() AND kcu.TABLE_NAME = ? AND kcu.CONSTRAINT_NAME = ? ORDER BY kcu.ORDINAL_POSITION`, [TABLE, name]);
  return rows;
}
const indexExists = async (knex, name) => (await indexRows(knex, name)).length > 0;
const fkExists = async (knex, name) => (await fkRows(knex, name)).length > 0;
const columnExists = async (knex, col) => !!(await columnRow(knex, col));

exports.up = async (knex) => {
  if (!(await tableExists(knex, TABLE))) {
    await knex.raw(`
      CREATE TABLE ${TABLE} (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        tenant_id BIGINT UNSIGNED NULL,
        actor_user_id BIGINT UNSIGNED NULL,
        actor_role VARCHAR(20) NULL,
        action VARCHAR(48) NOT NULL,
        resource VARCHAR(48) NOT NULL,
        resource_id VARCHAR(64) NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'ok',
        ip VARCHAR(45) NULL,
        metadata JSON NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_alog_tenant_created (tenant_id, created_at),
        KEY idx_alog_action (action),
        KEY idx_alog_actor (actor_user_id),
        CONSTRAINT fk_alog_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
        CONSTRAINT fk_alog_actor FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    return;
  }
  // Tabela já existe: valida definição e completa o que falta (idempotente, sem reconstruir).
  for (const col of COLUMNS) {
    const row = await columnRow(knex, col.name);
    if (row) {
      if (!validateColumn(row, col).ok) throw new Error(`Coluna ${TABLE}.${col.name} existe com definição INCOMPATÍVEL (esperado ${col.type}, nullable=${col.nullable}).`);
    } else if (col.name !== 'id') {
      await knex.raw(`ALTER TABLE ${TABLE} ADD COLUMN ${col.ddl}`);
    }
  }
  for (const idx of INDEXES) {
    const v = validateIndexColumns(await indexRows(knex, idx.name), idx.cols);
    if (v.exists && !v.ok) throw new Error(`Índice ${idx.name} existe com definição INCOMPATÍVEL (esperado [${idx.cols.join(', ')}]).`);
    if (!v.exists) await knex.raw(`ALTER TABLE ${TABLE} ADD KEY ${idx.name} (${idx.ddl})`);
  }
  for (const fk of FKS) {
    const v = validateForeignKey(await fkRows(knex, fk.name), fk.spec);
    if (v.exists && !v.ok) throw new Error(`FK ${fk.name} existe com definição INCOMPATÍVEL.`);
    if (!v.exists) await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${fk.name} ${fk.ddl}`);
  }
};

exports.down = async (knex) => {
  if (await tableExists(knex, TABLE)) await knex.raw(`DROP TABLE ${TABLE}`);
};

exports._helpers = { validateIndexColumns, validateForeignKey, validateColumn, tableExists, columnExists, indexExists, fkExists };
