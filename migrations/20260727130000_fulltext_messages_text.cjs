// Índice FULLTEXT em messages.text para busca por palavra-chave (Fase 2).
//
// Pré-requisitos confirmados na inspeção:
// - MySQL 8.1.0 + InnoDB → FULLTEXT suportado em InnoDB.
// - messages.text = TEXT, nullable, utf8mb4 → compatível. NULL não é indexado nem casa em MATCH.
// - Nenhum índice FULLTEXT existente em messages.
//
// Uso na aplicação: `MATCH(text) AGAINST(? IN BOOLEAN MODE)` quando o termo for
// compatível; fallback para `LIKE` em termos vazios/curtos (< innodb_ft_min_token_size,
// default 3) ou com caracteres especiais do boolean mode. Ver server/routes/chats.js.
//
// ⚠️ LOCK/JANELA: criar FULLTEXT em InnoDB reconstrói o índice e pode segurar a tabela
// por tempo proporcional ao volume de `messages`. Em produção EXIGE JANELA DE MANUTENÇÃO
// APROVADA. Em dev o banco está vazio → instantâneo. NÃO EXECUTAR EM PRODUÇÃO sem janela.

async function hasFulltext(knex) {
  const [rows] = await knex.raw(
    `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'messages'
       AND INDEX_NAME = 'ft_messages_text' AND INDEX_TYPE = 'FULLTEXT'`);
  return rows[0].c > 0;
}

exports.up = async (knex) => {
  if (!(await hasFulltext(knex))) {
    await knex.raw('ALTER TABLE messages ADD FULLTEXT INDEX ft_messages_text (text)');
  }
};

exports.down = async (knex) => {
  if (await hasFulltext(knex)) {
    await knex.raw('ALTER TABLE messages DROP INDEX ft_messages_text');
  }
};
