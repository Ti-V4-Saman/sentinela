import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import knexFactory from 'knex';
import knexConfig from '../knexfile.cjs';
import bridge from '../migrations/20260727120000_add_capture_wid_bridge.cjs';
import fulltext from '../migrations/20260727130000_fulltext_messages_text.cjs';

let knex;
beforeAll(async () => { knex = knexFactory(knexConfig.development); await knex.migrate.latest(); });
afterAll(async () => { await knex.destroy(); });

// ---- Validadores puros (cobrem o caso "índice de mesmo nome, definição incompatível") ----
describe('migration ponte capture_wid — validateUniqueCaptureIndex', () => {
  const { validateUniqueCaptureIndex } = bridge._helpers;
  it('sem linhas → não existe', () => {
    expect(validateUniqueCaptureIndex([])).toEqual({ exists: false, ok: false });
  });
  it('UNIQUE sobre capture_wid → ok', () => {
    expect(validateUniqueCaptureIndex([{ NON_UNIQUE: 0, COLUMN_NAME: 'capture_wid' }])).toEqual({ exists: true, ok: true });
  });
  it('mesmo nome, NÃO-unique → incompatível', () => {
    expect(validateUniqueCaptureIndex([{ NON_UNIQUE: 1, COLUMN_NAME: 'capture_wid' }])).toEqual({ exists: true, ok: false });
  });
  it('mesmo nome, coluna errada → incompatível', () => {
    expect(validateUniqueCaptureIndex([{ NON_UNIQUE: 0, COLUMN_NAME: 'phone_number' }])).toEqual({ exists: true, ok: false });
  });
  it('mesmo nome, multi-coluna → incompatível', () => {
    expect(validateUniqueCaptureIndex([
      { NON_UNIQUE: 0, COLUMN_NAME: 'capture_wid' }, { NON_UNIQUE: 0, COLUMN_NAME: 'tenant_id' },
    ])).toEqual({ exists: true, ok: false });
  });
});

describe('migration FULLTEXT — validateFulltextIndex', () => {
  const { validateFulltextIndex } = fulltext._helpers;
  it('sem linhas → não existe', () => {
    expect(validateFulltextIndex([])).toEqual({ exists: false, ok: false });
  });
  it('FULLTEXT sobre text → ok', () => {
    expect(validateFulltextIndex([{ INDEX_TYPE: 'FULLTEXT', COLUMN_NAME: 'text' }])).toEqual({ exists: true, ok: true });
  });
  it('mesmo nome, não-FULLTEXT (BTREE) → incompatível', () => {
    expect(validateFulltextIndex([{ INDEX_TYPE: 'BTREE', COLUMN_NAME: 'text' }])).toEqual({ exists: true, ok: false });
  });
  it('mesmo nome, coluna errada → incompatível', () => {
    expect(validateFulltextIndex([{ INDEX_TYPE: 'FULLTEXT', COLUMN_NAME: 'type' }])).toEqual({ exists: true, ok: false });
  });
});

// ---- Estado real do banco (após migrate:latest) ----
describe('estado do schema após as migrations', () => {
  it('capture_wid existe e é nullable', async () => {
    expect(await bridge._helpers.columnExists(knex, 'capture_wid')).toBe(true);
    const [rows] = await knex.raw(
      `SELECT IS_NULLABLE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sentinela_instances' AND COLUMN_NAME='capture_wid'`);
    expect(rows[0].IS_NULLABLE).toBe('YES');
  });
  it('uq_si_capture_wid é UNIQUE sobre capture_wid', async () => {
    const v = bridge._helpers.validateUniqueCaptureIndex(await bridge._helpers.indexRows(knex, 'uq_si_capture_wid'));
    expect(v).toEqual({ exists: true, ok: true });
  });
  it('ft_messages_text é FULLTEXT sobre text', async () => {
    const v = fulltext._helpers.validateFulltextIndex(await fulltext._helpers.indexRows(knex));
    expect(v).toEqual({ exists: true, ok: true });
  });
});

// ---- Idempotência do up (re-rodar não altera nem lança) ----
// Obs.: o `down` NÃO é exercitado contra o banco vivo/compartilhado (regra do projeto:
// nunca rodar migrate:rollback no banco vivo; DDL do MySQL não é transacional). A lógica
// do down é coberta pelos validadores acima + revisão. A idempotência do up é segura.
describe('idempotência do up', () => {
  it('re-rodar up da ponte é no-op (não lança)', async () => {
    await expect(bridge.up(knex)).resolves.not.toThrow();
    expect(await bridge._helpers.columnExists(knex, 'capture_wid')).toBe(true);
  });
  it('re-rodar up do FULLTEXT é no-op (não lança)', async () => {
    await expect(fulltext.up(knex)).resolves.not.toThrow();
    expect(fulltext._helpers.validateFulltextIndex(await fulltext._helpers.indexRows(knex)).ok).toBe(true);
  });
});
