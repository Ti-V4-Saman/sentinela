// Ponte entre a instância gerenciada (sentinela_instances) e a instância de
// captura usada em messages.wid (instances.wid). Fase 2.
//
// Decisões:
// - `capture_wid` VARCHAR(50) NULL: nullable = fail-closed (instância sem ponte
//   não dá acesso operacional às conversas). O tipo casa com instances.wid / messages.wid.
// - UNIQUE GLOBAL (uq_si_capture_wid): instances.wid é PK simples (único no banco
//   inteiro, entre tenants) → uma instância de captura mapeia para no máximo UMA
//   instância gerenciada. MySQL/InnoDB permite múltiplos NULL num índice UNIQUE,
//   então instâncias ainda sem ponte convivem sem colidir.
// - SEM FK rígida para instances.wid (avaliada e descartada nesta fase): a linha em
//   `instances` é criada pelo pipeline externo (n8n) na captura; a ponte pode ser
//   gravada no connect ANTES de existir mensagem/linha em `instances`. Uma FK rígida
//   bloquearia esse estado legítimo ("instância conectada, ainda sem captura"). A
//   integridade de tenant é validada na camada de aplicação (endpoint restrito a
//   superadmin/admin, checando que instances.wid pertence ao mesmo tenant).
//
// ⚠️ LOCK/JANELA: ADD COLUMN + ADD UNIQUE KEY reconstrói a tabela / faz lock de
// metadados no MySQL 8. Em produção com volume, exige JANELA DE MANUTENÇÃO APROVADA.
// Em dev o banco está vazio → aplicação instantânea. NÃO EXECUTAR EM PRODUÇÃO sem janela.

exports.up = async (knex) => {
  // Idempotência defensiva: só adiciona se ainda não existir.
  const [col] = await knex.raw(
    `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sentinela_instances' AND COLUMN_NAME = 'capture_wid'`);
  if (col[0].c === 0) {
    await knex.raw(
      `ALTER TABLE sentinela_instances
         ADD COLUMN capture_wid VARCHAR(50) NULL AFTER phone_number,
         ADD UNIQUE KEY uq_si_capture_wid (capture_wid)`);
  }
};

exports.down = async (knex) => {
  const [col] = await knex.raw(
    `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sentinela_instances' AND COLUMN_NAME = 'capture_wid'`);
  if (col[0].c > 0) {
    await knex.raw('ALTER TABLE sentinela_instances DROP KEY uq_si_capture_wid, DROP COLUMN capture_wid');
  }
};
