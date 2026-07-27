// Ponte entre a instância gerenciada (sentinela_instances) e a instância de captura
// usada em messages.wid (instances.wid). Fase 2.
//
// Decisões:
// - `capture_wid` VARCHAR(50) NULL: nullable = fail-closed.
// - UNIQUE GLOBAL (uq_si_capture_wid): instances.wid é PK simples (único no banco entre
//   tenants) → 1 captura ↔ no máx. 1 instância gerenciada. InnoDB permite múltiplos NULL.
// - SEM FK rígida: a linha em `instances` é criada pelo pipeline; a ponte pode ser gravada
//   antes. Integridade de tenant validada na aplicação (endpoint restrito a admin/superadmin).
//
// ⚠️ LOCK/JANELA: ADD COLUMN + ADD UNIQUE KEY reconstrói/segura a tabela no MySQL 8.
// Em produção EXIGE JANELA DE MANUTENÇÃO APROVADA. NÃO EXECUTAR EM PRODUÇÃO sem janela.
//
// Defensiva: coluna e índice verificados SEPARADAMENTE; índice de mesmo nome com definição
// incompatível falha com mensagem explícita (não é tratado como implementação válida).

const TABLE = 'sentinela_instances';
const COL = 'capture_wid';
const IDX = 'uq_si_capture_wid';

async function columnExists(knex, col) {
  const [rows] = await knex.raw(
    `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [TABLE, col]);
  return rows[0].c > 0;
}

async function indexRows(knex, name) {
  const [rows] = await knex.raw(
    `SELECT NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX, INDEX_TYPE FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? ORDER BY SEQ_IN_INDEX`,
    [TABLE, name]);
  return rows;
}

// Valida se as linhas de STATISTICS representam um índice UNIQUE sobre exatamente [capture_wid].
function validateUniqueCaptureIndex(rows) {
  if (!rows || rows.length === 0) return { exists: false, ok: false };
  const cols = rows.map((r) => r.COLUMN_NAME);
  const ok = rows.every((r) => Number(r.NON_UNIQUE) === 0) && cols.length === 1 && cols[0] === COL;
  return { exists: true, ok };
}

exports.up = async (knex) => {
  if (!(await columnExists(knex, COL))) {
    await knex.raw(`ALTER TABLE ${TABLE} ADD COLUMN ${COL} VARCHAR(50) NULL AFTER phone_number`);
  }
  const v = validateUniqueCaptureIndex(await indexRows(knex, IDX));
  if (!v.exists) {
    await knex.raw(`ALTER TABLE ${TABLE} ADD UNIQUE KEY ${IDX} (${COL})`);
  } else if (!v.ok) {
    throw new Error(`Índice '${IDX}' já existe com definição INCOMPATÍVEL (esperado UNIQUE sobre ${COL}). Corrija manualmente antes de migrar.`);
  }
};

exports.down = async (knex) => {
  if ((await indexRows(knex, IDX)).length > 0) {
    await knex.raw(`ALTER TABLE ${TABLE} DROP KEY ${IDX}`);
  }
  if (await columnExists(knex, COL)) {
    await knex.raw(`ALTER TABLE ${TABLE} DROP COLUMN ${COL}`);
  }
};

// Exportado para inspeção automatizada (não usado pelo knex).
exports._helpers = { validateUniqueCaptureIndex, columnExists, indexRows };
