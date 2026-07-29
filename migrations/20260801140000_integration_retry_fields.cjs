// Etapa B — máquina de estados de entrega/retry (R2): adiciona os campos persistidos de retry em
// `integration_delivery_batches` e estende o enum `status` com os 2 estados novos usados pelo
// job/worker (`blocked`, `pending_retry`) — ver docs/superpowers/plans/2026-07-28-etapaB-hardening.md,
// seção "Máquina de estados de entrega/retry (R2/R3/R4)".
//
// Campos novos:
// - attempt_count INT UNSIGNED NOT NULL DEFAULT 0 — nº de tentativas já feitas.
// - next_attempt_at DATETIME NULL — quando a próxima tentativa de retry fica elegível.
// - last_attempt_at DATETIME NULL — quando a última tentativa ocorreu (base do backoff).
// status ENUM: ('pending','delivering','delivered','failed') -> adiciona 'blocked' e
// 'pending_retry', preservando os 4 valores originais e seus significados.
// Índice novo: idx_batch_due (tenant_id, status, next_attempt_at) — suporta a consulta do job que
// busca batches elegíveis por tenant/status/vencimento sem full scan.
//
// Defensiva/idempotente: cada coluna é adicionada só se ausente; o índice só se ausente; o enum só
// é alterado (MODIFY COLUMN) se estiver no conjunto ANTIGO de 4 valores — se já tiver os 6
// (inclusive blocked/pending_retry), no-op; se for QUALQUER outro conjunto, lança erro explícito
// "... INCOMPATIBLE" (não altera silenciosamente um enum de origem desconhecida).
//
// Reversível: down() remove as 3 colunas e o índice se presentes, e devolve o enum ao conjunto de
// 4 valores original — só seguro se não houver linhas usando 'blocked'/'pending_retry' (o schema de
// teste isolado usado no down() dinâmico nunca tem essas linhas; em produção isto NÃO deve rodar —
// regra do projeto: nunca `migrate:rollback` no banco vivo).
//
// ⚠️ ADD COLUMN/MODIFY COLUMN reconstrói/segura tabela no MySQL 8 → em produção EXIGE JANELA
// APROVADA. NÃO EXECUTAR EM PRODUÇÃO. Validada SOMENTE no banco de teste.

const BATCHES = 'integration_delivery_batches';
const STATUS_COL = 'status';
const OLD_ENUM_VALUES = ['pending', 'delivering', 'delivered', 'failed'];
const NEW_ENUM_VALUES = ['pending', 'blocked', 'delivering', 'pending_retry', 'delivered', 'failed'];
const OLD_ENUM_SQL = `ENUM(${OLD_ENUM_VALUES.map((v) => `'${v}'`).join(',')})`;
const NEW_ENUM_SQL = `ENUM(${NEW_ENUM_VALUES.map((v) => `'${v}'`).join(',')})`;
const IDX_DUE = 'idx_batch_due';

async function tableExists(knex, name) {
  const [rows] = await knex.raw(
    'SELECT COUNT(*) AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [name],
  );
  return rows[0].c > 0;
}

async function columnRow(knex, table, col) {
  const [rows] = await knex.raw(
    'SELECT COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, col],
  );
  return rows[0];
}

async function columnExists(knex, table, col) {
  return !!(await columnRow(knex, table, col));
}

async function indexRows(knex, table, name) {
  const [rows] = await knex.raw(
    'SELECT COLUMN_NAME, SEQ_IN_INDEX FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? ORDER BY SEQ_IN_INDEX',
    [table, name],
  );
  return rows;
}

async function indexExists(knex, table, name) {
  return (await indexRows(knex, table, name)).length > 0;
}

// Extrai o conjunto de valores de um COLUMN_TYPE tipo "enum('a','b','c')".
function enumValuesFromColumnType(columnType) {
  const m = String(columnType).match(/^enum\((.*)\)$/i);
  if (!m) return null;
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  return b.every((v) => sa.has(v));
}

async function addColumnIfAbsent(knex, table, col, ddl) {
  if (await columnExists(knex, table, col)) return;
  await knex.raw(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

async function dropColumnIfPresent(knex, table, col) {
  if (!(await columnExists(knex, table, col))) return;
  await knex.raw(`ALTER TABLE ${table} DROP COLUMN ${col}`);
}

exports.up = async (knex) => {
  if (!(await tableExists(knex, BATCHES))) {
    throw new Error(`Tabela ${BATCHES} não existe — esperado que 20260801120000_integrations.cjs já tenha rodado (estado INCOMPATIBLE).`);
  }

  // attempt_count / next_attempt_at / last_attempt_at — adiciona se ausentes.
  await addColumnIfAbsent(knex, BATCHES, 'attempt_count', 'attempt_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER status');
  await addColumnIfAbsent(knex, BATCHES, 'next_attempt_at', 'next_attempt_at DATETIME NULL');
  await addColumnIfAbsent(knex, BATCHES, 'last_attempt_at', 'last_attempt_at DATETIME NULL');

  // status ENUM: extensão defensiva.
  const row = await columnRow(knex, BATCHES, STATUS_COL);
  if (!row) {
    throw new Error(`Coluna ${BATCHES}.${STATUS_COL} está AUSENTE — INCOMPATIBLE com o schema esperado desta migration.`);
  }
  const currentValues = enumValuesFromColumnType(row.COLUMN_TYPE);
  if (!currentValues) {
    throw new Error(`Coluna ${BATCHES}.${STATUS_COL} não é um ENUM (COLUMN_TYPE=${row.COLUMN_TYPE}) — INCOMPATIBLE com o schema esperado desta migration.`);
  }
  if (sameSet(currentValues, NEW_ENUM_VALUES)) {
    // já migrado — no-op idempotente.
  } else if (sameSet(currentValues, OLD_ENUM_VALUES)) {
    await knex.raw(`ALTER TABLE ${BATCHES} MODIFY COLUMN ${STATUS_COL} ${NEW_ENUM_SQL} NOT NULL DEFAULT 'pending'`);
  } else {
    throw new Error(`Coluna ${BATCHES}.${STATUS_COL} tem ENUM INCOMPATIBLE (atual: ${row.COLUMN_TYPE}) — esperado o conjunto antigo ${OLD_ENUM_SQL} ou o novo ${NEW_ENUM_SQL}.`);
  }

  // idx_batch_due — suporta a consulta do job de retry (tenant + status + vencimento).
  if (!(await indexExists(knex, BATCHES, IDX_DUE))) {
    await knex.raw(`ALTER TABLE ${BATCHES} ADD KEY ${IDX_DUE} (tenant_id, status, next_attempt_at)`);
  }
};

exports.down = async (knex) => {
  if (!(await tableExists(knex, BATCHES))) return;

  if (await indexExists(knex, BATCHES, IDX_DUE)) {
    await knex.raw(`ALTER TABLE ${BATCHES} DROP INDEX ${IDX_DUE}`);
  }

  await dropColumnIfPresent(knex, BATCHES, 'attempt_count');
  await dropColumnIfPresent(knex, BATCHES, 'next_attempt_at');
  await dropColumnIfPresent(knex, BATCHES, 'last_attempt_at');

  // Reverte o enum status ao conjunto original de 4 valores. Só é seguro se nenhuma linha usar
  // 'blocked'/'pending_retry' — é o caso do schema de teste isolado usado neste down() dinâmico.
  // Em produção este down NUNCA deve rodar (regra do projeto: sem migrate:rollback no banco vivo).
  const row = await columnRow(knex, BATCHES, STATUS_COL);
  if (row) {
    const currentValues = enumValuesFromColumnType(row.COLUMN_TYPE);
    if (currentValues && sameSet(currentValues, NEW_ENUM_VALUES)) {
      await knex.raw(`ALTER TABLE ${BATCHES} MODIFY COLUMN ${STATUS_COL} ${OLD_ENUM_SQL} NOT NULL DEFAULT 'pending'`);
    }
  }
};

exports._helpers = {
  tableExists,
  columnExists,
  columnRow,
  indexExists,
  indexRows,
  enumValuesFromColumnType,
  sameSet,
};
