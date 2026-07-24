// Baseline idempotente: as 6 tabelas já existem no banco `sentinela`, então
// CREATE TABLE IF NOT EXISTS é no-op lá e só registra este baseline no
// knex_migrations. Em ambiente vazio (novo), cria tudo do zero.
exports.up = async function (knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS chats (
      id varchar(50) NOT NULL,
      title varchar(255) DEFAULT NULL,
      is_group tinyint(1) DEFAULT NULL,
      created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS contacts (
      id varchar(50) NOT NULL,
      phone varchar(20) DEFAULT NULL,
      name varchar(255) DEFAULT NULL,
      created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS instances (
      wid varchar(50) NOT NULL,
      created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
      id varchar(64) DEFAULT NULL,
      name varchar(100) DEFAULT NULL,
      token varchar(128) DEFAULT NULL,
      contact_name varchar(100) DEFAULT NULL,
      phone_number varchar(50) DEFAULT NULL,
      avatar_url text,
      status varchar(50) DEFAULT 'Disconnected',
      webhook_url text,
      updated_at timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (wid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS sentinela_instances (
      id varchar(64) NOT NULL,
      name varchar(100) NOT NULL,
      token varchar(128) NOT NULL,
      status varchar(50) DEFAULT 'Disconnected',
      phone_number varchar(50) DEFAULT NULL,
      contact_name varchar(100) DEFAULT NULL,
      avatar_url text,
      webhook_url text,
      created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS messages (
      id varchar(50) NOT NULL,
      chat_id varchar(50) DEFAULT NULL,
      contact_id varchar(50) DEFAULT NULL,
      text text,
      type varchar(50) DEFAULT NULL,
      from_me tinyint(1) DEFAULT NULL,
      from_internal tinyint(1) DEFAULT NULL,
      timestamp timestamp NULL DEFAULT NULL,
      wid varchar(50) DEFAULT NULL,
      PRIMARY KEY (id),
      KEY wid (wid),
      KEY idx_chat_id (chat_id),
      KEY idx_contact_id (contact_id),
      KEY idx_timestamp (timestamp),
      CONSTRAINT messages_ibfk_1 FOREIGN KEY (chat_id) REFERENCES chats (id),
      CONSTRAINT messages_ibfk_2 FOREIGN KEY (contact_id) REFERENCES contacts (id),
      CONSTRAINT messages_ibfk_3 FOREIGN KEY (wid) REFERENCES instances (wid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS mentions (
      id bigint unsigned NOT NULL AUTO_INCREMENT,
      message_id varchar(50) DEFAULT NULL,
      phone varchar(20) DEFAULT NULL,
      name varchar(255) DEFAULT NULL,
      PRIMARY KEY (id),
      KEY message_id (message_id),
      CONSTRAINT mentions_ibfk_1 FOREIGN KEY (message_id) REFERENCES messages (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
};

// ⚠️ ATENÇÃO: rodar o `down` do baseline no banco `sentinela` DROPA as tabelas reais.
// Só é seguro em ambiente novo/vazio. applyMigrations()/npm run migrate NUNCA fazem rollback.
exports.down = async function (knex) {
  await knex.raw('DROP TABLE IF EXISTS mentions');
  await knex.raw('DROP TABLE IF EXISTS messages');
  await knex.raw('DROP TABLE IF EXISTS sentinela_instances');
  await knex.raw('DROP TABLE IF EXISTS instances');
  await knex.raw('DROP TABLE IF EXISTS contacts');
  await knex.raw('DROP TABLE IF EXISTS chats');
};
