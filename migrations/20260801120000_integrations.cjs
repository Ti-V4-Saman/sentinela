// Etapa B — Integração por webhook em lote (Configurações > Integrações).
//
// Cria as 3 tabelas novas usadas por toda a feature:
// - tenant_integrations: 1 config de integração por (tenant, type) — hoje só 'webhook_batch'.
// - integration_delivery_batches: lotes (janela + parte) exportados/a exportar por integração.
// - integration_delivery_attempts: tentativas de entrega HTTP de cada batch (auditoria técnica).
//
// Segurança: secret NUNCA é persistido em claro — só `secret_hash` (sha256 hex, não reversível
// para exibição) e `secret_masked` (ex.: 'whsec_••••ab12', só para exibição na UI). `error` em
// integration_delivery_attempts é sempre sanitizado na aplicação (sem secret/URL crua/corpo).
//
// ⚠️ ADD/CREATE reconstrói/segura tabela no MySQL 8 → em produção EXIGE JANELA APROVADA.
// NÃO EXECUTAR EM PRODUÇÃO. Defensiva: valida a DEFINIÇÃO de objetos de mesmo nome (colunas,
// índices, FKs) — incompatível FALHA com mensagem explícita contendo "INCOMPATIBLE"; idempotente
// (cria só o que falta). Reversível: down() remove as 3 tabelas na ordem inversa das FKs
// (attempts → batches → tenant_integrations). Validada SOMENTE no banco de teste — nunca rodar
// `migrate:rollback` no banco vivo (regra do projeto).

const TI = 'tenant_integrations';
const BATCHES = 'integration_delivery_batches';
const ATTEMPTS = 'integration_delivery_attempts';

// ---- Validadores PUROS (idênticos em formato aos das migrations anteriores; recebem linhas do
// information_schema e são testáveis sem banco via exports._helpers) ----
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

// ---- Especificações esperadas por tabela ----

const TI_COLUMNS = [
  { name: 'id', type: 'bigint unsigned', nullable: false },
  { name: 'tenant_id', type: 'bigint unsigned', nullable: false },
  { name: 'type', type: "enum('webhook_batch')", nullable: false },
  { name: 'active', type: 'tinyint(1)', nullable: false },
  { name: 'target_url', type: 'varchar(2048)', nullable: false },
  { name: 'secret_hash', type: 'varchar(255)', nullable: true },
  { name: 'secret_masked', type: 'varchar(64)', nullable: true },
  { name: 'secret_set_at', type: 'timestamp', nullable: true },
  { name: 'frequency', type: "enum('daily')", nullable: false },
  { name: 'run_at_time', type: 'char(5)', nullable: false },
  { name: 'timezone', type: 'varchar(64)', nullable: false },
  { name: 'include_direct', type: 'tinyint(1)', nullable: false },
  { name: 'include_groups', type: 'tinyint(1)', nullable: false },
  { name: 'include_from_me', type: 'tinyint(1)', nullable: false },
  { name: 'include_audio_transcripts', type: 'tinyint(1)', nullable: false },
  { name: 'last_run_window_end', type: 'datetime', nullable: true },
  { name: 'updated_by', type: 'bigint unsigned', nullable: true },
  { name: 'created_at', type: 'timestamp', nullable: false },
  { name: 'updated_at', type: 'timestamp', nullable: false },
];
const TI_INDEXES = [
  { name: 'uq_ti_tenant_type', cols: ['tenant_id', 'type'] },
  { name: 'idx_ti_active', cols: ['active'] },
];
const TI_FKS = [
  { name: 'fk_ti_tenant', spec: { columns: ['tenant_id'], referencedTable: 'tenants', referencedColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'NO ACTION' } },
  { name: 'fk_ti_updated_by', spec: { columns: ['updated_by'], referencedTable: 'users', referencedColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'NO ACTION' } },
];

const BATCH_COLUMNS = [
  { name: 'id', type: 'bigint unsigned', nullable: false },
  { name: 'tenant_id', type: 'bigint unsigned', nullable: false },
  { name: 'integration_id', type: 'bigint unsigned', nullable: false },
  { name: 'schema_version', type: 'int unsigned', nullable: false },
  { name: 'window_start', type: 'datetime', nullable: false },
  { name: 'window_end', type: 'datetime', nullable: false },
  { name: 'part', type: 'int unsigned', nullable: false },
  { name: 'part_total', type: 'int unsigned', nullable: false },
  { name: 'idempotency_key', type: 'varchar(120)', nullable: false },
  { name: 'status', type: "enum('pending','delivering','delivered','failed')", nullable: false },
  { name: 'conversation_count', type: 'int unsigned', nullable: false },
  { name: 'message_count', type: 'int unsigned', nullable: false },
  { name: 'created_at', type: 'timestamp', nullable: false },
  { name: 'updated_at', type: 'timestamp', nullable: false },
];
const BATCH_INDEXES = [
  { name: 'uq_batch_idem', cols: ['idempotency_key'] },
  { name: 'uq_batch_window', cols: ['tenant_id', 'integration_id', 'window_start', 'window_end', 'schema_version', 'part'] },
  { name: 'idx_batch_tenant_status', cols: ['tenant_id', 'status'] },
  { name: 'idx_batch_integration', cols: ['integration_id', 'window_end'] },
];
const BATCH_FKS = [
  { name: 'fk_batch_tenant', spec: { columns: ['tenant_id'], referencedTable: 'tenants', referencedColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'NO ACTION' } },
  { name: 'fk_batch_integration', spec: { columns: ['integration_id'], referencedTable: 'tenant_integrations', referencedColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'NO ACTION' } },
];

const ATTEMPT_COLUMNS = [
  { name: 'id', type: 'bigint unsigned', nullable: false },
  { name: 'tenant_id', type: 'bigint unsigned', nullable: false },
  { name: 'batch_id', type: 'bigint unsigned', nullable: false },
  { name: 'attempt_no', type: 'int unsigned', nullable: false },
  { name: 'status', type: "enum('success','failure')", nullable: false },
  { name: 'http_code', type: 'int', nullable: true },
  { name: 'duration_ms', type: 'int unsigned', nullable: true },
  { name: 'error', type: 'text', nullable: true },
  { name: 'created_at', type: 'timestamp', nullable: false },
];
const ATTEMPT_INDEXES = [
  { name: 'uq_attempt', cols: ['batch_id', 'attempt_no'] },
  { name: 'idx_attempt_tenant', cols: ['tenant_id', 'created_at'] },
];
const ATTEMPT_FKS = [
  { name: 'fk_attempt_tenant', spec: { columns: ['tenant_id'], referencedTable: 'tenants', referencedColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'NO ACTION' } },
  { name: 'fk_attempt_batch', spec: { columns: ['batch_id'], referencedTable: 'integration_delivery_batches', referencedColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'NO ACTION' } },
];

// ---- Consultas ao information_schema (parametrizadas por tabela) ----
async function tableExists(knex, name) {
  const [rows] = await knex.raw('SELECT COUNT(*) AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [name]);
  return rows[0].c > 0;
}
async function columnRow(knex, table, col) {
  const [rows] = await knex.raw('SELECT COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [table, col]);
  return rows[0];
}
async function indexRows(knex, table, name) {
  const [rows] = await knex.raw('SELECT COLUMN_NAME, SEQ_IN_INDEX FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? ORDER BY SEQ_IN_INDEX', [table, name]);
  return rows;
}
async function fkRows(knex, table, name) {
  const [rows] = await knex.raw(
    `SELECT kcu.COLUMN_NAME, kcu.ORDINAL_POSITION, kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME, rc.DELETE_RULE, rc.UPDATE_RULE
     FROM information_schema.KEY_COLUMN_USAGE kcu
     JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
       ON rc.CONSTRAINT_SCHEMA = kcu.TABLE_SCHEMA AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND rc.TABLE_NAME = kcu.TABLE_NAME
     WHERE kcu.TABLE_SCHEMA = DATABASE() AND kcu.TABLE_NAME = ? AND kcu.CONSTRAINT_NAME = ? ORDER BY kcu.ORDINAL_POSITION`, [table, name]);
  return rows;
}
const columnExists = async (knex, table, col) => !!(await columnRow(knex, table, col));
const indexExists = async (knex, table, name) => (await indexRows(knex, table, name)).length > 0;
const fkExists = async (knex, table, name) => (await fkRows(knex, table, name)).length > 0;

// ---- up() de uma tabela já existente: valida colunas essenciais / índices / FKs; completa o
// que faltar; lança erro explícito "... INCOMPATIBLE" em divergência de definição. ----
async function reconcileExistingTable(knex, table, columns, indexes, fks) {
  for (const col of columns) {
    const row = await columnRow(knex, table, col.name);
    if (row) {
      if (!validateColumn(row, col).ok) {
        throw new Error(`Coluna ${table}.${col.name} existe com definição INCOMPATIBLE (esperado ${col.type}, nullable=${col.nullable}).`);
      }
    }
    // Não adiciona colunas ausentes aqui: para estas 3 tabelas novas, se a tabela já existe mas
    // sem uma coluna essencial, é mais seguro falhar explicitamente do que alterar silenciosamente
    // um objeto de mesmo nome cuja origem é desconhecida.
    else {
      throw new Error(`Coluna ${table}.${col.name} está AUSENTE numa tabela ${table} pré-existente e INCOMPATIBLE com o schema esperado desta migration.`);
    }
  }
  for (const idx of indexes) {
    const v = validateIndexColumns(await indexRows(knex, table, idx.name), idx.cols);
    if (v.exists && !v.ok) throw new Error(`Índice ${idx.name} em ${table} existe com definição INCOMPATIBLE (esperado [${idx.cols.join(', ')}]).`);
    if (!v.exists) {
      const isUnique = idx.name.startsWith('uq_');
      await knex.raw(`ALTER TABLE ${table} ADD ${isUnique ? 'UNIQUE ' : ''}KEY ${idx.name} (${idx.cols.join(', ')})`);
    }
  }
  for (const fk of fks) {
    const v = validateForeignKey(await fkRows(knex, table, fk.name), fk.spec);
    if (v.exists && !v.ok) throw new Error(`FK ${fk.name} em ${table} existe com definição INCOMPATIBLE.`);
    if (!v.exists) {
      const { columns: cols, referencedTable, referencedColumns, onDelete, onUpdate } = fk.spec;
      await knex.raw(`ALTER TABLE ${table} ADD CONSTRAINT ${fk.name} FOREIGN KEY (${cols.join(', ')}) REFERENCES ${referencedTable} (${referencedColumns.join(', ')}) ON DELETE ${onDelete} ON UPDATE ${onUpdate}`);
    }
  }
}

exports.up = async (knex) => {
  // tenant_integrations
  if (!(await tableExists(knex, TI))) {
    await knex.raw(`
      CREATE TABLE ${TI} (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        tenant_id BIGINT UNSIGNED NOT NULL,
        type ENUM('webhook_batch') NOT NULL DEFAULT 'webhook_batch',
        active TINYINT(1) NOT NULL DEFAULT 0,
        target_url VARCHAR(2048) NOT NULL,
        secret_hash VARCHAR(255) NULL,
        secret_masked VARCHAR(64) NULL,
        secret_set_at TIMESTAMP NULL,
        frequency ENUM('daily') NOT NULL DEFAULT 'daily',
        run_at_time CHAR(5) NOT NULL DEFAULT '03:00',
        timezone VARCHAR(64) NOT NULL DEFAULT 'America/Sao_Paulo',
        include_direct TINYINT(1) NOT NULL DEFAULT 1,
        include_groups TINYINT(1) NOT NULL DEFAULT 1,
        include_from_me TINYINT(1) NOT NULL DEFAULT 1,
        include_audio_transcripts TINYINT(1) NOT NULL DEFAULT 0,
        last_run_window_end DATETIME NULL,
        updated_by BIGINT UNSIGNED NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_ti_tenant_type (tenant_id, type),
        KEY idx_ti_active (active),
        CONSTRAINT fk_ti_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_ti_updated_by FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  } else {
    await reconcileExistingTable(knex, TI, TI_COLUMNS, TI_INDEXES, TI_FKS);
  }

  // integration_delivery_batches (depende de tenant_integrations via FK)
  if (!(await tableExists(knex, BATCHES))) {
    await knex.raw(`
      CREATE TABLE ${BATCHES} (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        tenant_id BIGINT UNSIGNED NOT NULL,
        integration_id BIGINT UNSIGNED NOT NULL,
        schema_version INT UNSIGNED NOT NULL,
        window_start DATETIME NOT NULL,
        window_end DATETIME NOT NULL,
        part INT UNSIGNED NOT NULL DEFAULT 1,
        part_total INT UNSIGNED NOT NULL DEFAULT 1,
        idempotency_key VARCHAR(120) NOT NULL,
        status ENUM('pending','delivering','delivered','failed') NOT NULL DEFAULT 'pending',
        conversation_count INT UNSIGNED NOT NULL DEFAULT 0,
        message_count INT UNSIGNED NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_batch_idem (idempotency_key),
        UNIQUE KEY uq_batch_window (tenant_id, integration_id, window_start, window_end, schema_version, part),
        KEY idx_batch_tenant_status (tenant_id, status),
        KEY idx_batch_integration (integration_id, window_end),
        CONSTRAINT fk_batch_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_batch_integration FOREIGN KEY (integration_id) REFERENCES tenant_integrations(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  } else {
    await reconcileExistingTable(knex, BATCHES, BATCH_COLUMNS, BATCH_INDEXES, BATCH_FKS);
  }

  // integration_delivery_attempts (depende de integration_delivery_batches via FK)
  if (!(await tableExists(knex, ATTEMPTS))) {
    await knex.raw(`
      CREATE TABLE ${ATTEMPTS} (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        tenant_id BIGINT UNSIGNED NOT NULL,
        batch_id BIGINT UNSIGNED NOT NULL,
        attempt_no INT UNSIGNED NOT NULL,
        status ENUM('success','failure') NOT NULL,
        http_code INT NULL,
        duration_ms INT UNSIGNED NULL,
        error TEXT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_attempt (batch_id, attempt_no),
        KEY idx_attempt_tenant (tenant_id, created_at),
        CONSTRAINT fk_attempt_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_attempt_batch FOREIGN KEY (batch_id) REFERENCES integration_delivery_batches(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  } else {
    await reconcileExistingTable(knex, ATTEMPTS, ATTEMPT_COLUMNS, ATTEMPT_INDEXES, ATTEMPT_FKS);
  }
};

// Ordem inversa das FKs: attempts (referencia batches) → batches (referencia tenant_integrations)
// → tenant_integrations.
exports.down = async (knex) => {
  await knex.raw(`DROP TABLE IF EXISTS ${ATTEMPTS}`);
  await knex.raw(`DROP TABLE IF EXISTS ${BATCHES}`);
  await knex.raw(`DROP TABLE IF EXISTS ${TI}`);
};

exports._helpers = {
  validateIndexColumns,
  validateForeignKey,
  validateColumn,
  tableExists,
  columnExists,
  indexExists,
  fkExists,
  columnRow,
  indexRows,
  fkRows,
};
