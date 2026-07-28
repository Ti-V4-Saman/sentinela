// Etapa B — Integração por webhook em lote: renomeia/retipa a coluna de secret de
// `tenant_integrations` de HASH (não reversível) para CIFRADO EM REPOUSO (reversível).
//
// Contexto (defeito C1 — crítico): a migration anterior (20260801120000_integrations.cjs) já foi
// aplicada no banco de teste compartilhado, então não pode ser editada in-place (regra do
// projeto: migrations aplicadas são imutáveis). Esta segunda migration corrige o esquema de
// armazenamento do secret: em vez de `secret_hash` (sha256 do plaintext, não reversível — impedia
// a assinatura HMAC de deliveries reais, pois o receptor só tem o PLAINTEXT), a coluna passa a se
// chamar `secret_encrypted` e guarda o resultado de `encryptSecret()` (AES-256-GCM, reversível com
// `INTEGRATIONS_SECRET_KEY`). O tamanho (VARCHAR(255)) e a nulidade são preservados.
//
// Defensiva/idempotente: se `secret_encrypted` já existir, no-op. Se só `secret_hash` existir,
// renomeia via `CHANGE COLUMN` (preserva a coluna física, evitando novo ALTER pesado de criação).
// Se NENHUMA das duas existir (schema já noutro estado), lança erro explícito — divergência
// incompatível com o que esta migration assume.
//
// Reversível: down() renomeia `secret_encrypted` de volta para `secret_hash`.
//
// ⚠️ ADD/CHANGE COLUMN reconstrói/segura tabela no MySQL 8 → em produção EXIGE JANELA APROVADA.
// NÃO EXECUTAR EM PRODUÇÃO. Validada SOMENTE no banco de teste — nunca rodar `migrate:rollback`
// no banco vivo (regra do projeto).

const TI = 'tenant_integrations';
const OLD_COL = 'secret_hash';
const NEW_COL = 'secret_encrypted';
const COL_DEF = 'VARCHAR(255) NULL';

async function tableExists(knex, name) {
  const [rows] = await knex.raw(
    'SELECT COUNT(*) AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [name],
  );
  return rows[0].c > 0;
}

async function columnExists(knex, table, col) {
  const [rows] = await knex.raw(
    'SELECT COUNT(*) AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, col],
  );
  return rows[0].c > 0;
}

exports.up = async (knex) => {
  if (!(await tableExists(knex, TI))) {
    throw new Error(`Tabela ${TI} não existe — esperado que 20260801120000_integrations.cjs já tenha rodado (estado INCOMPATIBLE).`);
  }

  const hasNew = await columnExists(knex, TI, NEW_COL);
  if (hasNew) {
    return; // já migrado — no-op idempotente.
  }

  const hasOld = await columnExists(knex, TI, OLD_COL);
  if (!hasOld) {
    throw new Error(`Nem ${TI}.${OLD_COL} nem ${TI}.${NEW_COL} existem — estado INCOMPATIBLE com o esperado por esta migration.`);
  }

  await knex.raw(`ALTER TABLE ${TI} CHANGE COLUMN ${OLD_COL} ${NEW_COL} ${COL_DEF}`);
};

exports.down = async (knex) => {
  if (!(await tableExists(knex, TI))) return;
  const hasNew = await columnExists(knex, TI, NEW_COL);
  if (!hasNew) return; // já revertido/nunca aplicado — no-op.
  await knex.raw(`ALTER TABLE ${TI} CHANGE COLUMN ${NEW_COL} ${OLD_COL} ${COL_DEF}`);
};

exports._helpers = { tableExists, columnExists };
