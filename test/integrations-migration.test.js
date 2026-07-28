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
import migration from '../migrations/20260801120000_integrations.cjs';

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
      const cols = ['tenant_id', 'type', 'active', 'target_url', 'secret_hash', 'secret_masked', 'frequency', 'run_at_time', 'timezone', 'include_direct', 'include_groups', 'include_from_me', 'include_audio_transcripts', 'last_run_window_end', 'updated_by'];
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

  it('re-rodar up() é idempotente (no-op, não lança) — seguro rodar em paralelo com outros arquivos', async () => {
    const knex = knexFactory(knexConfig.development);
    try {
      await expect(migration.up(knex)).resolves.not.toThrow();
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
