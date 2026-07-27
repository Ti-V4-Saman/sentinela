// Índice FULLTEXT em messages.text para busca por palavra-chave (Fase 2).
//
// Pré-requisitos (inspeção): MySQL 8.1 + InnoDB; messages.text = TEXT nullable utf8mb4;
// NULL não é indexado nem casa em MATCH. Uso: MATCH(text) AGAINST(? IN BOOLEAN MODE),
// com fallback LIKE para termos curtos/incompatíveis (ver conversationScope.messageTextSearch).
//
// ⚠️ LOCK/JANELA: criar FULLTEXT em InnoDB reconstrói o índice; em produção EXIGE JANELA
// DE MANUTENÇÃO APROVADA. NÃO EXECUTAR EM PRODUÇÃO sem janela.
//
// Defensiva: se existir um índice de mesmo nome que NÃO seja FULLTEXT sobre `text`, falha
// explicitamente (não trata índice incompatível como implementação válida).

const TABLE = 'messages';
const IDX = 'ft_messages_text';
const COL = 'text';

async function indexRows(knex) {
  const [rows] = await knex.raw(
    `SELECT INDEX_TYPE, COLUMN_NAME, SEQ_IN_INDEX FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? ORDER BY SEQ_IN_INDEX`,
    [TABLE, IDX]);
  return rows;
}

// Valida se as linhas representam um índice FULLTEXT sobre exatamente [text].
function validateFulltextIndex(rows) {
  if (!rows || rows.length === 0) return { exists: false, ok: false };
  const cols = rows.map((r) => r.COLUMN_NAME);
  const ok = rows.every((r) => r.INDEX_TYPE === 'FULLTEXT') && cols.length === 1 && cols[0] === COL;
  return { exists: true, ok };
}

exports.up = async (knex) => {
  const v = validateFulltextIndex(await indexRows(knex));
  if (!v.exists) {
    await knex.raw(`ALTER TABLE ${TABLE} ADD FULLTEXT INDEX ${IDX} (${COL})`);
  } else if (!v.ok) {
    throw new Error(`Índice '${IDX}' já existe mas NÃO é FULLTEXT sobre \`${COL}\`. Corrija manualmente antes de migrar.`);
  }
};

exports.down = async (knex) => {
  if ((await indexRows(knex)).length > 0) {
    await knex.raw(`ALTER TABLE ${TABLE} DROP INDEX ${IDX}`);
  }
};

exports._helpers = { validateFulltextIndex, indexRows };
