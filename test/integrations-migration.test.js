// Task 1 (Etapa B — integração webhook em lote): migração defensiva/reversível das 3 tabelas
// tenant_integrations / integration_delivery_batches / integration_delivery_attempts.
//
// ISOLAMENTO DE BANCO — leia antes de alterar este arquivo:
// A suíte inteira compartilha UM banco de teste remoto e o Vitest roda os arquivos de teste em
// PARALELO (pool "forks"). Por isso:
//   1) O teste de "up cria as 3 tabelas" roda no pool COMPARTILHADO via applyMigrations() — é
//      aditivo/idempotente e seguro mesmo com outros arquivos de teste rodando ao mesmo tempo
//      (mesmo padrão de test/migrations.test.js).
//   2) Reversibilidade (down) e o cenário de incompatibilidade (coluna pré-existente com tipo
//      errado) SÓ podem ser exercitados de verdade num schema isolado, senão o DROP TABLE
//      derruba as tabelas por baixo de outros arquivos de teste rodando em paralelo. Este
//      arquivo tenta CREATE DATABASE sentinela_migtest_b1 num schema descartável; se o usuário
//      do banco não tiver privilégio CREATE DATABASE (é o caso do usuário de teste remoto deste
//      projeto — verificado manualmente: "Access denied ... to database ..."), os testes de
//      down/incompatibilidade são pulados (it.skip) com motivo explícito, e a lógica do down()
//      é validada por inspeção estática do texto da migration (garante DROP TABLE IF EXISTS na
//      ordem inversa das FKs), sem NUNCA rodar rollback no banco compartilhado — mesma regra já
//      documentada em test/migrations.test.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import knexFactory from 'knex';
import knexConfig from '../knexfile.cjs';
import { getPool, applyMigrations } from './helpers/db.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import migration from '../migrations/20260801120000_integrations.cjs';
import secretMigration from '../migrations/20260801130000_integrations_secret_encrypted.cjs';
import retryMigration from '../migrations/20260801140000_integration_retry_fields.cjs';
import snapshotMigration from '../migrations/20260801150000_integration_batch_payload_snapshot.cjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const THROWAWAY_DB = 'sentinela_migtest_b1';

async function tryCreateThrowawaySchema() {
  const admin = knexFactory(knexConfig.development);
  try {
    await admin.raw(`CREATE DATABASE \`${THROWAWAY_DB}\``);
    return true;
  } catch {
    return false;
  } finally {
    await admin.destroy();
  }
}

async function dropThrowawaySchema() {
  const admin = knexFactory(knexConfig.development);
  try {
    await admin.raw(`DROP DATABASE IF EXISTS \`${THROWAWAY_DB}\``);
  } catch {
    /* noop */
  } finally {
    await admin.destroy();
  }
}

function makeThrowawayKnex() {
  const base = knexConfig.development;
  return knexFactory({
    ...base,
    connection: { ...base.connection, database: THROWAWAY_DB },
  });
}

let canCreateDatabase = false;

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  await applyMigrations();
  canCreateDatabase = await tryCreateThrowawaySchema();
});

afterAll(async () => {
  await getPool().end();
  if (canCreateDatabase) await dropThrowawaySchema();
});

describe('migration integrations — estado do schema compartilhado (aditivo, seguro em paralelo)', () => {
  it('cria tenant_integrations com colunas-chave e UNIQUE uq_ti_tenant_type', async () => {
    const knex = knexFactory(knexConfig.development);
    try {
      expect(await migration._helpers.tableExists(knex, 'tenant_integrations')).toBe(true);
      // secret_encrypted (não secret_hash): a coluna foi renomeada/retipada pela migration
      // 20260801130000_integrations_secret_encrypted.cjs (defeito C1 — ver describe dedicado
      // abaixo), que já rodou por applyMigrations() (knex.migrate.latest()) neste beforeAll.
      const cols = ['tenant_id', 'type', 'active', 'target_url', 'secret_encrypted', 'secret_masked', 'frequency', 'run_at_time', 'timezone', 'include_direct', 'include_groups', 'include_from_me', 'include_audio_transcripts', 'last_run_window_end', 'updated_by'];
      for (const c of cols) {
        expect(await migration._helpers.columnExists(knex, 'tenant_integrations', c), `coluna tenant_integrations.${c} deveria existir`).toBe(true);
      }
      expect(await migration._helpers.indexExists(knex, 'tenant_integrations', 'uq_ti_tenant_type')).toBe(true);
      expect(await migration._helpers.indexExists(knex, 'tenant_integrations', 'idx_ti_active')).toBe(true);
      expect(await migration._helpers.fkExists(knex, 'tenant_integrations', 'fk_ti_tenant')).toBe(true);
      expect(await migration._helpers.fkExists(knex, 'tenant_integrations', 'fk_ti_updated_by')).toBe(true);
    } finally {
      await knex.destroy();
    }
  });

  it('cria integration_delivery_batches com colunas-chave e UNIQUEs uq_batch_idem/uq_batch_window', async () => {
    const knex = knexFactory(knexConfig.development);
    try {
      expect(await migration._helpers.tableExists(knex, 'integration_delivery_batches')).toBe(true);
      const cols = ['tenant_id', 'integration_id', 'schema_version', 'window_start', 'window_end', 'part', 'part_total', 'idempotency_key', 'status', 'conversation_count', 'message_count'];
      for (const c of cols) {
        expect(await migration._helpers.columnExists(knex, 'integration_delivery_batches', c), `coluna integration_delivery_batches.${c} deveria existir`).toBe(true);
      }
      expect(await migration._helpers.indexExists(knex, 'integration_delivery_batches', 'uq_batch_idem')).toBe(true);
      expect(await migration._helpers.indexExists(knex, 'integration_delivery_batches', 'uq_batch_window')).toBe(true);
      expect(await migration._helpers.indexExists(knex, 'integration_delivery_batches', 'idx_batch_tenant_status')).toBe(true);
      expect(await migration._helpers.indexExists(knex, 'integration_delivery_batches', 'idx_batch_integration')).toBe(true);
      expect(await migration._helpers.fkExists(knex, 'integration_delivery_batches', 'fk_batch_tenant')).toBe(true);
      expect(await migration._helpers.fkExists(knex, 'integration_delivery_batches', 'fk_batch_integration')).toBe(true);
    } finally {
      await knex.destroy();
    }
  });

  it('cria integration_delivery_attempts com colunas-chave e UNIQUE uq_attempt', async () => {
    const knex = knexFactory(knexConfig.development);
    try {
      expect(await migration._helpers.tableExists(knex, 'integration_delivery_attempts')).toBe(true);
      const cols = ['tenant_id', 'batch_id', 'attempt_no', 'status', 'http_code', 'duration_ms', 'error'];
      for (const c of cols) {
        expect(await migration._helpers.columnExists(knex, 'integration_delivery_attempts', c), `coluna integration_delivery_attempts.${c} deveria existir`).toBe(true);
      }
      expect(await migration._helpers.indexExists(knex, 'integration_delivery_attempts', 'uq_attempt')).toBe(true);
      expect(await migration._helpers.indexExists(knex, 'integration_delivery_attempts', 'idx_attempt_tenant')).toBe(true);
      expect(await migration._helpers.fkExists(knex, 'integration_delivery_attempts', 'fk_attempt_tenant')).toBe(true);
      expect(await migration._helpers.fkExists(knex, 'integration_delivery_attempts', 'fk_attempt_batch')).toBe(true);
    } finally {
      await knex.destroy();
    }
  });

  // NOTA (introduzida por 20260801140000_integration_retry_fields.cjs, migration R2 — máquina de
  // estados de entrega/retry): esta migration (120000) já estava aplicada no banco de teste
  // compartilhado e é imutável (regra do projeto), então BATCH_COLUMNS.status continua fixado no
  // enum ANTIGO de 4 valores ("enum('pending','delivering','delivered','failed')") e
  // reconcileExistingTable() faz comparação EXATA de string (validateColumn, sem `anyOf` — ao
  // contrário de secret_hash/secret_encrypted, aqui o NOME da coluna não muda, só o conjunto de
  // valores, e o `anyOf` só cobre nomes alternativos). Depois que 140000 estende `status` para 6
  // valores no banco compartilhado, re-invocar migration.up(knex) diretamente (bypassando o
  // controle de versão do Knex) passa a lançar INCOMPATIBLE de propósito — sinaliza corretamente
  // que o schema real diverge da definição fixa desta migration antiga. Isso é esperado e correto;
  // a idempotência real do fluxo é garantida por `knex.migrate.latest()` (aplica cada migration
  // uma única vez, nunca re-executa 120000 depois de 140000), exercitada em applyMigrations() no
  // beforeAll. Este teste passa a documentar o throw em vez de assumir no-op.
  it('re-rodar up() diretamente após 140000 estender o enum status lança INCOMPATIBLE (comportamento esperado — ver nota acima); knex.migrate.latest() nunca re-executa 120000, então o fluxo real permanece idempotente', async () => {
    const knex = knexFactory(knexConfig.development);
    try {
      await expect(migration.up(knex)).rejects.toThrow(/INCOMPATIBLE/i);
      // as tabelas continuam existindo e íntegras — o throw ocorre só na validação do enum, após
      // as duas primeiras tabelas (tenant_integrations, já reconciliada) terem sido processadas.
      expect(await migration._helpers.tableExists(knex, 'tenant_integrations')).toBe(true);
      expect(await migration._helpers.tableExists(knex, 'integration_delivery_batches')).toBe(true);
      expect(await migration._helpers.tableExists(knex, 'integration_delivery_attempts')).toBe(true);
    } finally {
      await knex.destroy();
    }
  });
});

describe('migration integrations — reversibilidade (down) em schema isolado descartável', () => {
  it('up() cria as 3 tabelas e down() as derruba (attempts → batches → tenant_integrations), só no schema isolado', async (ctx) => {
    if (!canCreateDatabase) {
      ctx.skip('Usuário de teste sem privilégio CREATE DATABASE — down() coberto só por inspeção estática (ver describe de fallback abaixo). Não roda rollback no banco compartilhado.');
      return;
    }
    const knex = makeThrowawayKnex();
    try {
      await migration.up(knex);
      expect(await migration._helpers.tableExists(knex, 'tenant_integrations')).toBe(true);
      expect(await migration._helpers.tableExists(knex, 'integration_delivery_batches')).toBe(true);
      expect(await migration._helpers.tableExists(knex, 'integration_delivery_attempts')).toBe(true);

      await migration.down(knex);
      expect(await migration._helpers.tableExists(knex, 'integration_delivery_attempts')).toBe(false);
      expect(await migration._helpers.tableExists(knex, 'integration_delivery_batches')).toBe(false);
      expect(await migration._helpers.tableExists(knex, 'tenant_integrations')).toBe(false);
    } finally {
      await knex.destroy();
    }
  });
});

describe('migration integrations — incompatibilidade em schema isolado descartável', () => {
  it('lança erro explícito (INCOMPATIBLE) se tenant_integrations já existir com target_url INT', async (ctx) => {
    if (!canCreateDatabase) {
      ctx.skip('Usuário de teste sem privilégio CREATE DATABASE — cenário de incompatibilidade não pode ser montado num schema isolado. Ver describe de fallback abaixo.');
      return;
    }
    const knex = makeThrowawayKnex();
    try {
      await knex.raw(`
        CREATE TABLE tenant_integrations (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          tenant_id BIGINT UNSIGNED NOT NULL,
          target_url INT NOT NULL,
          PRIMARY KEY (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

      await expect(migration.up(knex)).rejects.toThrow(/INCOMPATIBLE|INCOMPAT[IÍ]VEL/i);
    } finally {
      await knex.raw('DROP TABLE IF EXISTS tenant_integrations');
      await knex.destroy();
    }
  });
});

// ---- Fallback quando o usuário de teste NÃO tem privilégio CREATE DATABASE ----
// Cobre por inspeção estática o que os testes acima cobririam dinamicamente, sem tocar o
// banco compartilhado: garante que down() dropa as 3 tabelas na ordem inversa das FKs.
describe('migration integrations — inspeção estática do down() (fallback sem CREATE DATABASE)', () => {
  it('documenta se o schema isolado pôde ser criado nesta execução', () => {
    if (!canCreateDatabase) {
      console.warn('[integrations-migration.test.js] Usuário de teste sem privilégio CREATE DATABASE — ' +
        'testes de down()/incompatibilidade rodaram apenas por inspeção estática. Não é uma falha: é a ' +
        'salvaguarda documentada no plano para não fazer rollback no banco de teste compartilhado.');
    }
    expect(typeof canCreateDatabase).toBe('boolean');
  });

  it('down() referencia DROP TABLE IF EXISTS para as 3 tabelas, na ordem attempts → batches → tenant_integrations', () => {
    const src = migration.down.toString();
    // down() usa `DROP TABLE IF EXISTS ${ATTEMPTS/BATCHES/TI}` com as constantes de nome de
    // tabela do topo do arquivo — confirma tanto os 3 DROP TABLE IF EXISTS quanto a ordem.
    const drops = [...src.matchAll(/DROP TABLE IF EXISTS \$\{(\w+)\}/g)].map((m) => m[1]);
    expect(drops).toEqual(['ATTEMPTS', 'BATCHES', 'TI']);
  });
});

// ---- 20260801130000_integrations_secret_encrypted.cjs (defeito C1 — secret cifrado em repouso) ----
// A migration original (20260801120000) já estava aplicada no banco de teste compartilhado quando
// o defeito foi corrigido, então não pôde ser editada in-place — esta segunda migration renomeia
// `secret_hash` -> `secret_encrypted` (CHANGE COLUMN, mesmo VARCHAR(255) NULL). Roda via
// applyMigrations() no beforeAll deste arquivo (knex.migrate.latest() aplica TODAS as pendentes).
describe('migration integrations_secret_encrypted — coluna renomeada no banco compartilhado', () => {
  it('tenant_integrations tem secret_encrypted e NÃO tem mais secret_hash', async () => {
    const knex = knexFactory(knexConfig.development);
    try {
      expect(await secretMigration._helpers.columnExists(knex, 'tenant_integrations', 'secret_encrypted')).toBe(true);
      expect(await secretMigration._helpers.columnExists(knex, 'tenant_integrations', 'secret_hash')).toBe(false);
    } finally {
      await knex.destroy();
    }
  });

  it('re-rodar up() é idempotente (no-op, não lança) — seguro em paralelo com outros arquivos', async () => {
    const knex = knexFactory(knexConfig.development);
    try {
      await expect(secretMigration.up(knex)).resolves.not.toThrow();
      expect(await secretMigration._helpers.columnExists(knex, 'tenant_integrations', 'secret_encrypted')).toBe(true);
    } finally {
      await knex.destroy();
    }
  });
});

describe('migration integrations_secret_encrypted — reversibilidade (down) em schema isolado descartável', () => {
  it('up() renomeia secret_hash->secret_encrypted e down() reverte, só no schema isolado', async (ctx) => {
    if (!canCreateDatabase) {
      ctx.skip('Usuário de teste sem privilégio CREATE DATABASE — down() coberto só por inspeção estática abaixo.');
      return;
    }
    const knex = makeThrowawayKnex();
    try {
      await migration.up(knex); // cria as 3 tabelas com secret_hash (schema original)
      expect(await secretMigration._helpers.columnExists(knex, 'tenant_integrations', 'secret_hash')).toBe(true);

      await secretMigration.up(knex);
      expect(await secretMigration._helpers.columnExists(knex, 'tenant_integrations', 'secret_encrypted')).toBe(true);
      expect(await secretMigration._helpers.columnExists(knex, 'tenant_integrations', 'secret_hash')).toBe(false);

      await secretMigration.down(knex);
      expect(await secretMigration._helpers.columnExists(knex, 'tenant_integrations', 'secret_hash')).toBe(true);
      expect(await secretMigration._helpers.columnExists(knex, 'tenant_integrations', 'secret_encrypted')).toBe(false);
    } finally {
      await migration.down(knex);
      await knex.destroy();
    }
  });

  it('documenta se o schema isolado pôde ser criado nesta execução (fallback sem CREATE DATABASE)', () => {
    if (!canCreateDatabase) {
      console.warn('[integrations-migration.test.js] secret_encrypted: down() validado só por inspeção estática.');
    }
    const upSrc = secretMigration.up.toString();
    const downSrc = secretMigration.down.toString();
    expect(upSrc).toMatch(/CHANGE COLUMN \$\{OLD_COL\} \$\{NEW_COL\}/);
    expect(downSrc).toMatch(/CHANGE COLUMN \$\{NEW_COL\} \$\{OLD_COL\}/);
  });
});

// ---- 20260801140000_integration_retry_fields.cjs (R2 — máquina de estados de entrega/retry) ----
// Adiciona attempt_count/next_attempt_at/last_attempt_at + estende o enum status com
// 'blocked'/'pending_retry' + índice idx_batch_due. Roda via applyMigrations() no beforeAll deste
// arquivo (knex.migrate.latest() aplica TODAS as pendentes, incluindo esta).
describe('migration integration_retry_fields — campos e enum no banco compartilhado', () => {
  it('integration_delivery_batches tem attempt_count/next_attempt_at/last_attempt_at', async () => {
    const knex = knexFactory(knexConfig.development);
    try {
      expect(await retryMigration._helpers.columnExists(knex, 'integration_delivery_batches', 'attempt_count')).toBe(true);
      expect(await retryMigration._helpers.columnExists(knex, 'integration_delivery_batches', 'next_attempt_at')).toBe(true);
      expect(await retryMigration._helpers.columnExists(knex, 'integration_delivery_batches', 'last_attempt_at')).toBe(true);
    } finally {
      await knex.destroy();
    }
  });

  it('status ENUM foi estendido com blocked e pending_retry', async () => {
    const knex = knexFactory(knexConfig.development);
    try {
      const row = await retryMigration._helpers.columnRow(knex, 'integration_delivery_batches', 'status');
      expect(row).toBeTruthy();
      expect(row.COLUMN_TYPE).toMatch(/'blocked'/);
      expect(row.COLUMN_TYPE).toMatch(/'pending_retry'/);
      // ainda contém os 4 valores originais
      for (const v of ['pending', 'delivering', 'delivered', 'failed']) {
        expect(row.COLUMN_TYPE).toMatch(new RegExp(`'${v}'`));
      }
    } finally {
      await knex.destroy();
    }
  });

  it('cria o índice idx_batch_due (tenant_id, status, next_attempt_at)', async () => {
    const knex = knexFactory(knexConfig.development);
    try {
      expect(await retryMigration._helpers.indexExists(knex, 'integration_delivery_batches', 'idx_batch_due')).toBe(true);
    } finally {
      await knex.destroy();
    }
  });

  it('re-rodar up() é idempotente (no-op, não lança) — seguro em paralelo com outros arquivos', async () => {
    const knex = knexFactory(knexConfig.development);
    try {
      await expect(retryMigration.up(knex)).resolves.not.toThrow();
      expect(await retryMigration._helpers.columnExists(knex, 'integration_delivery_batches', 'attempt_count')).toBe(true);
      const row = await retryMigration._helpers.columnRow(knex, 'integration_delivery_batches', 'status');
      expect(row.COLUMN_TYPE).toMatch(/'blocked'/);
      expect(row.COLUMN_TYPE).toMatch(/'pending_retry'/);
    } finally {
      await knex.destroy();
    }
  });
});

describe('migration integration_retry_fields — reversibilidade (down) em schema isolado descartável', () => {
  it('up() adiciona campos/estende enum e down() reverte, só no schema isolado', async (ctx) => {
    if (!canCreateDatabase) {
      ctx.skip('Usuário de teste sem privilégio CREATE DATABASE — down() coberto só por inspeção estática abaixo.');
      return;
    }
    const knex = makeThrowawayKnex();
    try {
      await migration.up(knex); // cria as 3 tabelas (status enum original de 4 valores)
      await retryMigration.up(knex);

      expect(await retryMigration._helpers.columnExists(knex, 'integration_delivery_batches', 'attempt_count')).toBe(true);
      expect(await retryMigration._helpers.columnExists(knex, 'integration_delivery_batches', 'next_attempt_at')).toBe(true);
      expect(await retryMigration._helpers.columnExists(knex, 'integration_delivery_batches', 'last_attempt_at')).toBe(true);
      expect(await retryMigration._helpers.indexExists(knex, 'integration_delivery_batches', 'idx_batch_due')).toBe(true);
      let row = await retryMigration._helpers.columnRow(knex, 'integration_delivery_batches', 'status');
      expect(row.COLUMN_TYPE).toMatch(/'blocked'/);
      expect(row.COLUMN_TYPE).toMatch(/'pending_retry'/);

      await retryMigration.down(knex);

      expect(await retryMigration._helpers.columnExists(knex, 'integration_delivery_batches', 'attempt_count')).toBe(false);
      expect(await retryMigration._helpers.columnExists(knex, 'integration_delivery_batches', 'next_attempt_at')).toBe(false);
      expect(await retryMigration._helpers.columnExists(knex, 'integration_delivery_batches', 'last_attempt_at')).toBe(false);
      expect(await retryMigration._helpers.indexExists(knex, 'integration_delivery_batches', 'idx_batch_due')).toBe(false);
      row = await retryMigration._helpers.columnRow(knex, 'integration_delivery_batches', 'status');
      expect(row.COLUMN_TYPE).not.toMatch(/'blocked'/);
      expect(row.COLUMN_TYPE).not.toMatch(/'pending_retry'/);
    } finally {
      await migration.down(knex);
      await knex.destroy();
    }
  });

  it('documenta se o schema isolado pôde ser criado nesta execução (fallback sem CREATE DATABASE)', () => {
    if (!canCreateDatabase) {
      console.warn('[integrations-migration.test.js] retry_fields: down() validado só por inspeção estática.');
    }
    const upSrc = retryMigration.up.toString();
    expect(upSrc).toMatch(/attempt_count/);
    // dropColumnIfPresent (usada por down()) não é exposta em _helpers; inspeciona o arquivo
    // inteiro para confirmar que down() de fato emite DROP COLUMN.
    const fileSrc = readFileSync(path.join(__dirname, '../migrations/20260801140000_integration_retry_fields.cjs'), 'utf8');
    expect(fileSrc).toMatch(/DROP COLUMN/);
  });
});

describe('migration integration_retry_fields — incompatibilidade em schema isolado descartável', () => {
  it('lança erro explícito (INCOMPATIBLE) se status já for um ENUM diferente/incompatível', async (ctx) => {
    if (!canCreateDatabase) {
      ctx.skip('Usuário de teste sem privilégio CREATE DATABASE — cenário de incompatibilidade não pode ser montado num schema isolado.');
      return;
    }
    const knex = makeThrowawayKnex();
    try {
      await migration.up(knex); // cria as 3 tabelas com status enum original
      // simula um estado incompatível: outro deploy já alterou o enum para algo que não é nem o
      // conjunto antigo (4 valores) nem o novo (6 valores) desta migration.
      await knex.raw("ALTER TABLE integration_delivery_batches MODIFY COLUMN status ENUM('pending','sent') NOT NULL DEFAULT 'pending'");

      await expect(retryMigration.up(knex)).rejects.toThrow(/INCOMPATIBLE/i);
    } finally {
      await migration.down(knex);
      await knex.destroy();
    }
  });
});

// ---- 20260801150000_integration_batch_payload_snapshot.cjs (S1 — snapshot imutável do payload) ----
// Adiciona 7 colunas NULLABLE a integration_delivery_batches para persistir o corpo EXATO
// assinado+enviado na criação do batch (payload_compressed/payload_sha256/payload_size_bytes/
// payload_encoding/payload_created_at/target_url_snapshot/content_options_snapshot). Colunas
// NULLABLE no DB (defensivo em banco populado); completude é imposta na aplicação (createBatch
// sempre grava; attemptBatchDelivery recusa batch sem snapshot — ver plano). Roda via
// applyMigrations() no beforeAll deste arquivo (knex.migrate.latest() aplica TODAS as pendentes,
// incluindo esta).
describe('migration integration_batch_payload_snapshot — colunas no banco compartilhado', () => {
  it('integration_delivery_batches tem as 7 colunas de snapshot com os tipos esperados', async () => {
    const knex = knexFactory(knexConfig.development);
    try {
      const expected = {
        payload_compressed: 'longblob',
        payload_sha256: 'char(64)',
        payload_size_bytes: 'int unsigned',
        payload_encoding: 'varchar(32)',
        payload_created_at: 'datetime',
        target_url_snapshot: 'varchar(2048)',
        content_options_snapshot: 'json',
      };
      for (const [col, type] of Object.entries(expected)) {
        const row = await snapshotMigration._helpers.columnRow(knex, 'integration_delivery_batches', col);
        expect(row, `coluna integration_delivery_batches.${col} deveria existir`).toBeTruthy();
        expect(row.COLUMN_TYPE.toLowerCase(), `tipo de integration_delivery_batches.${col}`).toBe(type);
        expect(row.IS_NULLABLE.toUpperCase(), `nulidade de integration_delivery_batches.${col}`).toBe('YES');
      }
    } finally {
      await knex.destroy();
    }
  });

  it('re-rodar up() é idempotente (no-op, não lança) — seguro em paralelo com outros arquivos', async () => {
    const knex = knexFactory(knexConfig.development);
    try {
      await expect(snapshotMigration.up(knex)).resolves.not.toThrow();
      expect(await snapshotMigration._helpers.columnExists(knex, 'integration_delivery_batches', 'payload_compressed')).toBe(true);
      expect(await snapshotMigration._helpers.columnExists(knex, 'integration_delivery_batches', 'content_options_snapshot')).toBe(true);
    } finally {
      await knex.destroy();
    }
  });
});

describe('migration integration_batch_payload_snapshot — reversibilidade (down) em schema isolado descartável', () => {
  it('up() adiciona as 7 colunas e down() as remove, só no schema isolado', async (ctx) => {
    if (!canCreateDatabase) {
      ctx.skip('Usuário de teste sem privilégio CREATE DATABASE — down() coberto só por inspeção estática abaixo.');
      return;
    }
    const knex = makeThrowawayKnex();
    try {
      await migration.up(knex); // cria as 3 tabelas
      await snapshotMigration.up(knex);

      const cols = ['payload_compressed', 'payload_sha256', 'payload_size_bytes', 'payload_encoding', 'payload_created_at', 'target_url_snapshot', 'content_options_snapshot'];
      for (const c of cols) {
        expect(await snapshotMigration._helpers.columnExists(knex, 'integration_delivery_batches', c), `coluna ${c} deveria existir após up()`).toBe(true);
      }

      await snapshotMigration.down(knex);

      for (const c of cols) {
        expect(await snapshotMigration._helpers.columnExists(knex, 'integration_delivery_batches', c), `coluna ${c} deveria ter sido removida por down()`).toBe(false);
      }
    } finally {
      await migration.down(knex);
      await knex.destroy();
    }
  });

  it('documenta se o schema isolado pôde ser criado nesta execução (fallback sem CREATE DATABASE)', () => {
    if (!canCreateDatabase) {
      console.warn('[integrations-migration.test.js] payload_snapshot: down() validado só por inspeção estática.');
    }
    const fileSrc = readFileSync(path.join(__dirname, '../migrations/20260801150000_integration_batch_payload_snapshot.cjs'), 'utf8');
    expect(fileSrc).toMatch(/payload_compressed/);
    expect(fileSrc).toMatch(/DROP COLUMN/);
  });
});

describe('migration integration_batch_payload_snapshot — incompatibilidade em schema isolado descartável', () => {
  it('lança erro explícito (INCOMPATIBLE) se payload_sha256 já existir com tipo incompatível (INT)', async (ctx) => {
    if (!canCreateDatabase) {
      ctx.skip('Usuário de teste sem privilégio CREATE DATABASE — cenário de incompatibilidade não pode ser montado num schema isolado.');
      return;
    }
    const knex = makeThrowawayKnex();
    try {
      await migration.up(knex); // cria as 3 tabelas
      // simula um estado incompatível: alguma outra origem já criou a coluna payload_sha256 com
      // um tipo que não é o CHAR(64) esperado por esta migration.
      await knex.raw('ALTER TABLE integration_delivery_batches ADD COLUMN payload_sha256 INT NULL');

      await expect(snapshotMigration.up(knex)).rejects.toThrow(/INCOMPATIBLE/i);
    } finally {
      await migration.down(knex);
      await knex.destroy();
    }
  });
});
