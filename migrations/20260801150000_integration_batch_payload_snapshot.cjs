// Etapa B — Snapshot imutável do payload (S1, revisão #2 do PR #15) — ver
// docs/superpowers/plans/2026-07-28-etapaB-payload-snapshot.md, seções "Formato do snapshot" e
// "Migration (S1)".
//
// Fecha o bloqueio de idempotência: hoje `attemptBatchDelivery` reconstrói o payload no momento
// da tentativa, então o mesmo Idempotency-Key pode ser reenviado com corpo diferente (mensagem
// editada/apagada, transcrição tardia, config alterada, chunking mudado). Correção: persistir o
// corpo EXATO na criação do batch e sempre assinar+enviar esses bytes.
//
// Campos novos em integration_delivery_batches (todos NULLABLE no DB):
// - payload_compressed LONGBLOB NULL — rawBody (JSON.stringify(partPayload)) comprimido com gzip.
// - payload_sha256 CHAR(64) NULL — sha256(utf8(rawBody)) hex, sobre os bytes EXATOS assinados e
//   enviados (não sobre o comprimido).
// - payload_size_bytes INT UNSIGNED NULL — Buffer.byteLength(rawBody, 'utf8') (descomprimido).
// - payload_encoding VARCHAR(32) NULL — ex.: 'gzip' (esquema versionável).
// - payload_created_at DATETIME NULL.
// - target_url_snapshot VARCHAR(2048) NULL — integration.target_url no momento da criação do
//   batch (retry/reenvio entregam ao destino originalmente configurado).
// - content_options_snapshot JSON NULL — snapshot mínimo das flags include_* usadas (auditoria
//   apenas; não afeta a entrega, pois o corpo já está congelado).
//
// (a) NULLABLE no DB, completude na aplicação: estas colunas são NULLABLE a nível de banco
//     (defensivo — permite a migration rodar em segurança mesmo numa hipotética tabela já
//     populada), mas a aplicação impõe completude: `createBatch` SEMPRE grava as 7 colunas juntas
//     no mesmo INSERT (nunca existe batch utilizável sem snapshot completo — regra 1 do plano), e
//     `attemptBatchDelivery` recusa explicitamente enviar qualquer batch cujo snapshot esteja
//     ausente ou inconsistente (erro de integridade, não envia — regras 2/3/testes 8-9 do plano).
// (b) Banco de teste: 0 linhas em integration_delivery_batches no momento desta migration, logo
//     não há necessidade de backfill.
// (c) Estratégia para banco populado (documentação — este projeto só executa em teste): batches
//     pré-existentes SEM snapshot (colunas NULL) tornam-se NÃO-ENTREGÁVEIS — `attemptBatchDelivery`
//     deve detectar o NULL e lançar um erro explícito de integridade em vez de reconstruir/enviar
//     silenciosamente um payload divergente. Ficam nesse estado até serem re-criados ou até um
//     backfill manual (fora do escopo desta migration) preencher o snapshot a partir da mesma
//     lógica de criação usada por `createBatch`. Nunca enviar um batch sem snapshot válido.
//
// Defensiva/idempotente: cada coluna é adicionada só se ausente; coluna pré-existente de mesmo
// nome com tipo INCOMPATÍVEL faz a migration falhar com erro explícito contendo "INCOMPATIBLE"
// (nunca altera silenciosamente um objeto de origem desconhecida). Sem índice novo — o payload não
// é consultado por valor (ver plano, item 7); não se cria índice sobre LONGBLOB.
//
// Reversível: down() remove as 7 colunas se presentes, mesma disciplina de
// 20260801140000_integration_retry_fields.cjs.
//
// ⚠️ ADD COLUMN reconstrói/segura tabela no MySQL 8 → em produção EXIGE JANELA APROVADA. NÃO
// EXECUTAR EM PRODUÇÃO. Validada SOMENTE no banco de teste — nunca rodar `migrate:rollback` no
// banco vivo (regra do projeto).

const BATCHES = 'integration_delivery_batches';

const SNAPSHOT_COLUMNS = [
  { name: 'payload_compressed', ddl: 'payload_compressed LONGBLOB NULL', expectedType: 'longblob' },
  { name: 'payload_sha256', ddl: 'payload_sha256 CHAR(64) NULL', expectedType: 'char(64)' },
  { name: 'payload_size_bytes', ddl: 'payload_size_bytes INT UNSIGNED NULL', expectedType: 'int unsigned' },
  { name: 'payload_encoding', ddl: 'payload_encoding VARCHAR(32) NULL', expectedType: 'varchar(32)' },
  { name: 'payload_created_at', ddl: 'payload_created_at DATETIME NULL', expectedType: 'datetime' },
  { name: 'target_url_snapshot', ddl: 'target_url_snapshot VARCHAR(2048) NULL', expectedType: 'varchar(2048)' },
  { name: 'content_options_snapshot', ddl: 'content_options_snapshot JSON NULL', expectedType: 'json' },
];

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

  for (const col of SNAPSHOT_COLUMNS) {
    const row = await columnRow(knex, BATCHES, col.name);
    if (row) {
      const typeOk = String(row.COLUMN_TYPE).toLowerCase() === col.expectedType;
      const nullOk = String(row.IS_NULLABLE).toUpperCase() === 'YES';
      if (!typeOk || !nullOk) {
        throw new Error(`Coluna ${BATCHES}.${col.name} existe com definição INCOMPATIBLE (atual: ${row.COLUMN_TYPE}, IS_NULLABLE=${row.IS_NULLABLE}; esperado: ${col.expectedType} NULL).`);
      }
      continue; // já compatível — no-op idempotente.
    }
    await addColumnIfAbsent(knex, BATCHES, col.name, col.ddl);
  }
};

exports.down = async (knex) => {
  if (!(await tableExists(knex, BATCHES))) return;

  for (const col of SNAPSHOT_COLUMNS) {
    await dropColumnIfPresent(knex, BATCHES, col.name);
  }
};

exports._helpers = {
  tableExists,
  columnExists,
  columnRow,
  SNAPSHOT_COLUMNS,
};
