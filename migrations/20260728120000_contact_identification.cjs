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
// Defensiva: cada objeto (tabela, coluna, índice, FK) é verificado antes de criar/dropar,
// tornando a migration re-executável sem erro.

const CONTACTS = 'contacts';
const TYPES = 'contact_types';

async function tableExists(knex, name) {
  const [rows] = await knex.raw(
    `SELECT COUNT(*) AS c FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [name]);
  return rows[0].c > 0;
}
async function columnExists(knex, table, col) {
  const [rows] = await knex.raw(
    `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [table, col]);
  return rows[0].c > 0;
}
async function indexExists(knex, table, name) {
  const [rows] = await knex.raw(
    `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`, [table, name]);
  return rows[0].c > 0;
}
async function fkExists(knex, table, name) {
  const [rows] = await knex.raw(
    `SELECT COUNT(*) AS c FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?
       AND CONSTRAINT_TYPE = 'FOREIGN KEY'`, [table, name]);
  return rows[0].c > 0;
}

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
  }

  const addCol = async (col, ddl) => {
    if (!(await columnExists(knex, CONTACTS, col))) {
      await knex.raw(`ALTER TABLE ${CONTACTS} ADD COLUMN ${ddl}`);
    }
  };
  await addCol('display_name', 'display_name VARCHAR(255) NULL AFTER name');
  await addCol('contact_type_id', 'contact_type_id BIGINT UNSIGNED NULL AFTER display_name');
  await addCol('linked_user_id', 'linked_user_id BIGINT UNSIGNED NULL AFTER contact_type_id');
  await addCol('identification_source', "identification_source ENUM('manual','auto') NULL AFTER linked_user_id");
  await addCol('identified_by_user_id', 'identified_by_user_id BIGINT UNSIGNED NULL AFTER identification_source');
  await addCol('identified_at', 'identified_at TIMESTAMP NULL AFTER identified_by_user_id');

  const addIdx = async (name, ddl) => {
    if (!(await indexExists(knex, CONTACTS, name))) {
      await knex.raw(`ALTER TABLE ${CONTACTS} ADD KEY ${name} (${ddl})`);
    }
  };
  await addIdx('idx_contact_type', 'tenant_id, contact_type_id');
  await addIdx('idx_contact_linked_user', 'linked_user_id');
  await addIdx('idx_contact_ident_src', 'tenant_id, identification_source');

  const addFk = async (name, ddl) => {
    if (!(await fkExists(knex, CONTACTS, name))) {
      await knex.raw(`ALTER TABLE ${CONTACTS} ADD CONSTRAINT ${name} ${ddl}`);
    }
  };
  await addFk('fk_contact_type',
    `FOREIGN KEY (tenant_id, contact_type_id) REFERENCES ${TYPES} (tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT`);
  await addFk('fk_contact_linked_user',
    'FOREIGN KEY (linked_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE RESTRICT');
  await addFk('fk_contact_ident_by',
    'FOREIGN KEY (identified_by_user_id) REFERENCES users (id) ON DELETE SET NULL ON UPDATE RESTRICT');
};

exports.down = async (knex) => {
  const dropFk = async (name) => {
    if (await fkExists(knex, CONTACTS, name)) await knex.raw(`ALTER TABLE ${CONTACTS} DROP FOREIGN KEY ${name}`);
  };
  await dropFk('fk_contact_type');
  await dropFk('fk_contact_linked_user');
  await dropFk('fk_contact_ident_by');

  const dropIdx = async (name) => {
    if (await indexExists(knex, CONTACTS, name)) await knex.raw(`ALTER TABLE ${CONTACTS} DROP KEY ${name}`);
  };
  await dropIdx('idx_contact_type');
  await dropIdx('idx_contact_linked_user');
  await dropIdx('idx_contact_ident_src');

  const dropCol = async (col) => {
    if (await columnExists(knex, CONTACTS, col)) await knex.raw(`ALTER TABLE ${CONTACTS} DROP COLUMN ${col}`);
  };
  await dropCol('identified_at');
  await dropCol('identified_by_user_id');
  await dropCol('identification_source');
  await dropCol('linked_user_id');
  await dropCol('contact_type_id');
  await dropCol('display_name');

  if (await tableExists(knex, TYPES)) await knex.raw(`DROP TABLE ${TYPES}`);
};

// Exportado para inspeção automatizada (não usado pelo knex).
exports._helpers = { tableExists, columnExists, indexExists, fkExists };
