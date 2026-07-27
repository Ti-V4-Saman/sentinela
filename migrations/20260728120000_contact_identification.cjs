// Fase 4 — Identificação de contatos.
//
// Cria `contact_types` (categorias por tenant) e adiciona a `contacts` os campos de
// identificação: display_name, contact_type_id, linked_user_id, identification_source
// ('manual'|'auto'), identified_by_user_id, identified_at.
//
// Decisões de integridade (isolamento por tenant é invariante):
// - `contact_types`: PK simples (id AUTO_INCREMENT) + UNIQUE (tenant_id, name) e
//   UNIQUE (tenant_id, id). Esta última existe para permitir a FK COMPOSTA tenant-safe
//   a partir de `contacts`.
// - `contacts.contact_type_id`: FK COMPOSTA (tenant_id, contact_type_id) →
//   contact_types(tenant_id, id). Garante no banco que o tipo é do MESMO tenant do
//   contato. ON DELETE RESTRICT (não pode ser SET NULL: a FK inclui tenant_id NOT NULL);
//   a rota de exclusão de tipo desvincula os contatos (SET contact_type_id=NULL) antes.
// - `contacts.linked_user_id` / `identified_by_user_id`: FK simples → users(id)
//   ON DELETE SET NULL. A checagem de mesmo-tenant é feita na APLICAÇÃO (padrão já
//   adotado no projeto para referências a users), pois users.tenant_id é NULL p/ superadmin.
//
// ⚠️ LOCK/JANELA: ADD COLUMN/KEY/CONSTRAINT reconstrói/segura a tabela no MySQL 8.
// Em produção EXIGE JANELA DE MANUTENÇÃO APROVADA. NÃO EXECUTAR EM PRODUÇÃO sem janela.
//
// Defensiva: cada objeto (tabela, coluna, índice, FK) é verificado antes de criar. Um objeto de
// MESMO NOME com DEFINIÇÃO INCOMPATÍVEL (colunas/ordem de índice, colunas locais/tabela/colunas de
// destino e regras ON DELETE/UPDATE de FK, ou tipo/nulabilidade/enum de coluna) FALHA com mensagem
// explícita — não é tratado como concluído. Não reconstrói automaticamente estruturas incompatíveis.

const CONTACTS = 'contacts';
const TYPES = 'contact_types';

// ---- Validadores PUROS (recebem linhas do information_schema; testáveis sem banco) ----

// Índice: espera exatamente `expectedCols` na ordem. rows: [{COLUMN_NAME, SEQ_IN_INDEX}].
function validateIndexColumns(rows, expectedCols) {
  if (!rows || rows.length === 0) return { exists: false, ok: false };
  const cols = rows.slice().sort((a, b) => Number(a.SEQ_IN_INDEX) - Number(b.SEQ_IN_INDEX)).map((r) => r.COLUMN_NAME);
  const ok = cols.length === expectedCols.length && cols.every((c, i) => c === expectedCols[i]);
  return { exists: true, ok };
}

// FK: espera colunas locais (ordem), tabela/colunas de destino e regras ON DELETE/UPDATE.
// rows: [{COLUMN_NAME, ORDINAL_POSITION, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, DELETE_RULE, UPDATE_RULE}].
function validateForeignKey(rows, expected) {
  if (!rows || rows.length === 0) return { exists: false, ok: false };
  const sorted = rows.slice().sort((a, b) => Number(a.ORDINAL_POSITION) - Number(b.ORDINAL_POSITION));
  const cols = sorted.map((r) => r.COLUMN_NAME);
  const refCols = sorted.map((r) => r.REFERENCED_COLUMN_NAME);
  const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const ok = eq(cols, expected.columns)
    && sorted[0].REFERENCED_TABLE_NAME === expected.referencedTable
    && eq(refCols, expected.referencedColumns)
    && sorted[0].DELETE_RULE === expected.onDelete
    && sorted[0].UPDATE_RULE === expected.onUpdate;
  return { exists: true, ok };
}

// Coluna: espera tipo completo (COLUMN_TYPE — inclui enum(...) e unsigned) e nulabilidade.
// row: {COLUMN_TYPE, IS_NULLABLE} | undefined.
function validateColumn(row, expected) {
  if (!row) return { exists: false, ok: false };
  const typeOk = String(row.COLUMN_TYPE).toLowerCase() === String(expected.type).toLowerCase();
  const nullOk = (String(row.IS_NULLABLE).toUpperCase() === 'YES') === !!expected.nullable;
  return { exists: true, ok: typeOk && nullOk };
}

// ---- Especificações esperadas ----
const COLUMNS = [
  { name: 'display_name', type: 'varchar(255)', nullable: true, ddl: 'display_name VARCHAR(255) NULL AFTER name' },
  { name: 'contact_type_id', type: 'bigint unsigned', nullable: true, ddl: 'contact_type_id BIGINT UNSIGNED NULL AFTER display_name' },
  { name: 'linked_user_id', type: 'bigint unsigned', nullable: true, ddl: 'linked_user_id BIGINT UNSIGNED NULL AFTER contact_type_id' },
  { name: 'identification_source', type: "enum('manual','auto')", nullable: true, ddl: "identification_source ENUM('manual','auto') NULL AFTER linked_user_id" },
  { name: 'identified_by_user_id', type: 'bigint unsigned', nullable: true, ddl: 'identified_by_user_id BIGINT UNSIGNED NULL AFTER identification_source' },
  { name: 'identified_at', type: 'timestamp', nullable: true, ddl: 'identified_at TIMESTAMP NULL AFTER identified_by_user_id' },
];
const INDEXES = [
  { name: 'idx_contact_type', cols: ['tenant_id', 'contact_type_id'], ddl: 'tenant_id, contact_type_id' },
  { name: 'idx_contact_linked_user', cols: ['linked_user_id'], ddl: 'linked_user_id' },
  { name: 'idx_contact_ident_src', cols: ['tenant_id', 'identification_source'], ddl: 'tenant_id, identification_source' },
];
const FKS = [
  {
    name: 'fk_contact_type',
    ddl: 'FOREIGN KEY (tenant_id, contact_type_id) REFERENCES contact_types (tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT',
    spec: { columns: ['tenant_id', 'contact_type_id'], referencedTable: 'contact_types', referencedColumns: ['tenant_id', 'id'], onDelete: 'RESTRICT', onUpdate: 'RESTRICT' },
  },
  {
    name: 'fk_contact_linked_user',
    ddl: 'FOREIGN KEY (linked_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE RESTRICT',
    spec: { columns: ['linked_user_id'], referencedTable: 'users', referencedColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'RESTRICT' },
  },
  {
    name: 'fk_contact_ident_by',
    ddl: 'FOREIGN KEY (identified_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE RESTRICT',
    spec: { columns: ['identified_by_user_id'], referencedTable: 'users', referencedColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'RESTRICT' },
  },
];

// ---- Consultas ao information_schema ----
async function tableExists(knex, name) {
  const [rows] = await knex.raw(
    `SELECT COUNT(*) AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [name]);
  return rows[0].c > 0;
}
async function columnRow(knex, table, col) {
  const [rows] = await knex.raw(
    `SELECT COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [table, col]);
  return rows[0];
}
async function indexRows(knex, table, name) {
  const [rows] = await knex.raw(
    `SELECT COLUMN_NAME, SEQ_IN_INDEX FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? ORDER BY SEQ_IN_INDEX`, [table, name]);
  return rows;
}
async function fkRows(knex, table, name) {
  const [rows] = await knex.raw(
    `SELECT kcu.COLUMN_NAME, kcu.ORDINAL_POSITION, kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME,
            rc.DELETE_RULE, rc.UPDATE_RULE
     FROM information_schema.KEY_COLUMN_USAGE kcu
     JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
       ON rc.CONSTRAINT_SCHEMA = kcu.TABLE_SCHEMA AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND rc.TABLE_NAME = kcu.TABLE_NAME
     WHERE kcu.TABLE_SCHEMA = DATABASE() AND kcu.TABLE_NAME = ? AND kcu.CONSTRAINT_NAME = ?
     ORDER BY kcu.ORDINAL_POSITION`, [table, name]);
  return rows;
}
const columnExists = async (knex, table, col) => !!(await columnRow(knex, table, col));
const indexExists = async (knex, table, name) => (await indexRows(knex, table, name)).length > 0;
const fkExists = async (knex, table, name) => (await fkRows(knex, table, name)).length > 0;

exports.up = async (knex) => {
  if (!(await tableExists(knex, TYPES))) {
    await knex.raw(`
      CREATE TABLE ${TYPES} (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        tenant_id BIGINT UNSIGNED NOT NULL,
        name VARCHAR(80) NOT NULL,
        color VARCHAR(24) NOT NULL DEFAULT 'neutral',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_ctype_tenant_name (tenant_id, name),
        UNIQUE KEY uq_ctype_tenant_id (tenant_id, id),
        CONSTRAINT fk_ctype_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  } else {
    // Tabela já existe: o índice usado pela FK composta precisa estar íntegro.
    const v = validateIndexColumns(await indexRows(knex, TYPES, 'uq_ctype_tenant_id'), ['tenant_id', 'id']);
    if (v.exists && !v.ok) throw new Error("Índice 'uq_ctype_tenant_id' em contact_types existe com definição INCOMPATÍVEL (esperado UNIQUE (tenant_id, id)). Corrija manualmente.");
    if (!v.exists) await knex.raw(`ALTER TABLE ${TYPES} ADD UNIQUE KEY uq_ctype_tenant_id (tenant_id, id)`);
  }

  for (const col of COLUMNS) {
    const row = await columnRow(knex, CONTACTS, col.name);
    if (row) {
      if (!validateColumn(row, col).ok) {
        throw new Error(`Coluna contacts.${col.name} já existe com definição INCOMPATÍVEL (esperado ${col.type}, nullable=${col.nullable}). Corrija manualmente.`);
      }
    } else {
      await knex.raw(`ALTER TABLE ${CONTACTS} ADD COLUMN ${col.ddl}`);
    }
  }

  for (const idx of INDEXES) {
    const v = validateIndexColumns(await indexRows(knex, CONTACTS, idx.name), idx.cols);
    if (v.exists && !v.ok) throw new Error(`Índice ${idx.name} em contacts já existe com definição INCOMPATÍVEL (esperado [${idx.cols.join(', ')}]). Corrija manualmente.`);
    if (!v.exists) await knex.raw(`ALTER TABLE ${CONTACTS} ADD KEY ${idx.name} (${idx.ddl})`);
  }

  for (const fk of FKS) {
    const v = validateForeignKey(await fkRows(knex, CONTACTS, fk.name), fk.spec);
    if (v.exists && !v.ok) throw new Error(`FK ${fk.name} em contacts já existe com definição INCOMPATÍVEL (colunas/destino/regras). Corrija manualmente.`);
    if (!v.exists) await knex.raw(`ALTER TABLE ${CONTACTS} ADD CONSTRAINT ${fk.name} ${fk.ddl}`);
  }
};

exports.down = async (knex) => {
  for (const fk of FKS) {
    if (await fkExists(knex, CONTACTS, fk.name)) await knex.raw(`ALTER TABLE ${CONTACTS} DROP FOREIGN KEY ${fk.name}`);
  }
  for (const idx of INDEXES) {
    if (await indexExists(knex, CONTACTS, idx.name)) await knex.raw(`ALTER TABLE ${CONTACTS} DROP KEY ${idx.name}`);
  }
  for (const col of [...COLUMNS].reverse()) {
    if (await columnExists(knex, CONTACTS, col.name)) await knex.raw(`ALTER TABLE ${CONTACTS} DROP COLUMN ${col.name}`);
  }
  if (await tableExists(knex, TYPES)) await knex.raw(`DROP TABLE ${TYPES}`);
};

// Exportado para inspeção automatizada (não usado pelo knex).
exports._helpers = { validateIndexColumns, validateForeignKey, validateColumn, tableExists, columnExists, indexExists, fkExists };
