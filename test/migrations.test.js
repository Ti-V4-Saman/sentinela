import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import knexFactory from 'knex';
import knexConfig from '../knexfile.cjs';
import bridge from '../migrations/20260727120000_add_capture_wid_bridge.cjs';
import fulltext from '../migrations/20260727130000_fulltext_messages_text.cjs';
import contactIdent from '../migrations/20260728120000_contact_identification.cjs';
import accessLogs from '../migrations/20260729120000_access_logs.cjs';

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

// ---- Validadores da migration de identificação (Fase 4) ----
describe('migration identificação — validadores defensivos', () => {
  const { validateIndexColumns, validateForeignKey, validateColumn } = contactIdent._helpers;

  describe('validateIndexColumns', () => {
    it('sem linhas → não existe', () => {
      expect(validateIndexColumns([], ['tenant_id', 'id'])).toEqual({ exists: false, ok: false });
    });
    it('colunas corretas na ordem → ok', () => {
      const rows = [{ COLUMN_NAME: 'tenant_id', SEQ_IN_INDEX: 1 }, { COLUMN_NAME: 'id', SEQ_IN_INDEX: 2 }];
      expect(validateIndexColumns(rows, ['tenant_id', 'id'])).toEqual({ exists: true, ok: true });
    });
    it('mesmo nome, colunas erradas → incompatível', () => {
      const rows = [{ COLUMN_NAME: 'tenant_id', SEQ_IN_INDEX: 1 }, { COLUMN_NAME: 'name', SEQ_IN_INDEX: 2 }];
      expect(validateIndexColumns(rows, ['tenant_id', 'id'])).toEqual({ exists: true, ok: false });
    });
    it('mesmo nome, ordem trocada → incompatível', () => {
      const rows = [{ COLUMN_NAME: 'id', SEQ_IN_INDEX: 1 }, { COLUMN_NAME: 'tenant_id', SEQ_IN_INDEX: 2 }];
      expect(validateIndexColumns(rows, ['tenant_id', 'id']).ok).toBe(false);
    });
  });

  describe('validateForeignKey', () => {
    const spec = { columns: ['tenant_id', 'contact_type_id'], referencedTable: 'contact_types', referencedColumns: ['tenant_id', 'id'], onDelete: 'RESTRICT', onUpdate: 'RESTRICT' };
    const good = [
      { COLUMN_NAME: 'tenant_id', ORDINAL_POSITION: 1, REFERENCED_TABLE_NAME: 'contact_types', REFERENCED_COLUMN_NAME: 'tenant_id', DELETE_RULE: 'RESTRICT', UPDATE_RULE: 'RESTRICT' },
      { COLUMN_NAME: 'contact_type_id', ORDINAL_POSITION: 2, REFERENCED_TABLE_NAME: 'contact_types', REFERENCED_COLUMN_NAME: 'id', DELETE_RULE: 'RESTRICT', UPDATE_RULE: 'RESTRICT' },
    ];
    it('sem linhas → não existe', () => {
      expect(validateForeignKey([], spec)).toEqual({ exists: false, ok: false });
    });
    it('FK correta → ok', () => {
      expect(validateForeignKey(good, spec)).toEqual({ exists: true, ok: true });
    });
    it('tabela de destino errada → incompatível', () => {
      const bad = good.map((r) => ({ ...r, REFERENCED_TABLE_NAME: 'users' }));
      expect(validateForeignKey(bad, spec)).toEqual({ exists: true, ok: false });
    });
    it('coluna de destino errada → incompatível', () => {
      const bad = [good[0], { ...good[1], REFERENCED_COLUMN_NAME: 'name' }];
      expect(validateForeignKey(bad, spec).ok).toBe(false);
    });
    it('regra ON DELETE errada → incompatível', () => {
      const bad = good.map((r) => ({ ...r, DELETE_RULE: 'SET NULL' }));
      expect(validateForeignKey(bad, spec).ok).toBe(false);
    });
  });

  describe('validateColumn', () => {
    it('coluna ausente → não existe', () => {
      expect(validateColumn(undefined, { type: 'varchar(255)', nullable: true })).toEqual({ exists: false, ok: false });
    });
    it('tipo e nulabilidade corretos → ok', () => {
      expect(validateColumn({ COLUMN_TYPE: 'varchar(255)', IS_NULLABLE: 'YES' }, { type: 'varchar(255)', nullable: true })).toEqual({ exists: true, ok: true });
    });
    it('enum idêntico → ok', () => {
      expect(validateColumn({ COLUMN_TYPE: "enum('manual','auto')", IS_NULLABLE: 'YES' }, { type: "enum('manual','auto')", nullable: true }).ok).toBe(true);
    });
    it('tipo incompatível → incompatível', () => {
      expect(validateColumn({ COLUMN_TYPE: 'int', IS_NULLABLE: 'YES' }, { type: 'bigint unsigned', nullable: true }).ok).toBe(false);
    });
    it('nulabilidade incompatível → incompatível', () => {
      expect(validateColumn({ COLUMN_TYPE: 'varchar(255)', IS_NULLABLE: 'NO' }, { type: 'varchar(255)', nullable: true }).ok).toBe(false);
    });
    it('enum com valores diferentes → incompatível', () => {
      expect(validateColumn({ COLUMN_TYPE: "enum('manual','auto','x')", IS_NULLABLE: 'YES' }, { type: "enum('manual','auto')", nullable: true }).ok).toBe(false);
    });
  });
});

// ---- Validadores da migration access_logs (Fase 6) ----
describe('migration access_logs — validadores defensivos', () => {
  const { validateForeignKey, validateColumn } = accessLogs._helpers;
  it('FK tenant CASCADE correta → ok; regra errada → incompatível', () => {
    const spec = { columns: ['tenant_id'], referencedTable: 'tenants', referencedColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'RESTRICT' };
    const good = [{ COLUMN_NAME: 'tenant_id', ORDINAL_POSITION: 1, REFERENCED_TABLE_NAME: 'tenants', REFERENCED_COLUMN_NAME: 'id', DELETE_RULE: 'CASCADE', UPDATE_RULE: 'RESTRICT' }];
    expect(validateForeignKey(good, spec)).toEqual({ exists: true, ok: true });
    expect(validateForeignKey(good.map((r) => ({ ...r, DELETE_RULE: 'SET NULL' })), spec).ok).toBe(false);
  });
  it('coluna action NOT NULL varchar(48) correta; nulabilidade errada → incompatível', () => {
    expect(validateColumn({ COLUMN_TYPE: 'varchar(48)', IS_NULLABLE: 'NO' }, { type: 'varchar(48)', nullable: false }).ok).toBe(true);
    expect(validateColumn({ COLUMN_TYPE: 'varchar(48)', IS_NULLABLE: 'YES' }, { type: 'varchar(48)', nullable: false }).ok).toBe(false);
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
