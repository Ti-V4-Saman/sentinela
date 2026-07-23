// Converte chats/contacts/messages para PK composta (tenant_id, id) e denormaliza
// tenant_id em messages/mentions, com FKs compostas. Ordem: dropar FKs -> add
// tenant_id -> trocar PKs -> recriar FKs compostas. DB vazio => sem violação de dados.
// ON DELETE/UPDATE RESTRICT: dados read-only imutáveis, preservar integridade histórica.
exports.up = async (knex) => {
  // 1) Dropar FKs dependentes
  await knex.raw('ALTER TABLE mentions DROP FOREIGN KEY mentions_ibfk_1');
  await knex.raw('ALTER TABLE messages DROP FOREIGN KEY messages_ibfk_1'); // chat_id->chats
  await knex.raw('ALTER TABLE messages DROP FOREIGN KEY messages_ibfk_2'); // contact_id->contacts
  await knex.raw('ALTER TABLE messages DROP FOREIGN KEY messages_ibfk_3'); // wid->instances

  // 2) tenant_id nas tabelas de dados
  await knex.raw('ALTER TABLE chats ADD COLUMN tenant_id BIGINT UNSIGNED NOT NULL AFTER id');
  await knex.raw('ALTER TABLE contacts ADD COLUMN tenant_id BIGINT UNSIGNED NOT NULL AFTER id');
  await knex.raw('ALTER TABLE messages ADD COLUMN tenant_id BIGINT UNSIGNED NOT NULL AFTER id');
  await knex.raw('ALTER TABLE mentions ADD COLUMN tenant_id BIGINT UNSIGNED NOT NULL AFTER id');

  // 3) PKs compostas
  await knex.raw('ALTER TABLE chats DROP PRIMARY KEY, ADD PRIMARY KEY (tenant_id, id)');
  await knex.raw('ALTER TABLE contacts DROP PRIMARY KEY, ADD PRIMARY KEY (tenant_id, id)');
  await knex.raw('ALTER TABLE messages DROP PRIMARY KEY, ADD PRIMARY KEY (tenant_id, id)');

  // Índices auxiliares para as FKs compostas (coluna referenciante precisa de índice à esquerda)
  await knex.raw('ALTER TABLE messages ADD KEY idx_msg_tenant_chat (tenant_id, chat_id)');
  await knex.raw('ALTER TABLE messages ADD KEY idx_msg_tenant_contact (tenant_id, contact_id)');
  await knex.raw('ALTER TABLE mentions ADD KEY idx_mentions_tenant_msg (tenant_id, message_id)');

  // 4) Recriar FKs compostas + a de instances (wid)
  await knex.raw(`ALTER TABLE messages
    ADD CONSTRAINT fk_msg_chat FOREIGN KEY (tenant_id, chat_id) REFERENCES chats (tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT fk_msg_contact FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT fk_msg_instance FOREIGN KEY (wid) REFERENCES instances (wid) ON DELETE RESTRICT ON UPDATE RESTRICT`);

  await knex.raw(`ALTER TABLE mentions
    ADD CONSTRAINT fk_mentions_msg FOREIGN KEY (tenant_id, message_id) REFERENCES messages (tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT`);
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE mentions DROP FOREIGN KEY fk_mentions_msg');
  await knex.raw('ALTER TABLE messages DROP FOREIGN KEY fk_msg_chat, DROP FOREIGN KEY fk_msg_contact, DROP FOREIGN KEY fk_msg_instance');

  await knex.raw('ALTER TABLE mentions DROP KEY idx_mentions_tenant_msg');
  await knex.raw('ALTER TABLE messages DROP KEY idx_msg_tenant_chat, DROP KEY idx_msg_tenant_contact');

  await knex.raw('ALTER TABLE messages DROP PRIMARY KEY, ADD PRIMARY KEY (id)');
  await knex.raw('ALTER TABLE contacts DROP PRIMARY KEY, ADD PRIMARY KEY (id)');
  await knex.raw('ALTER TABLE chats DROP PRIMARY KEY, ADD PRIMARY KEY (id)');

  await knex.raw('ALTER TABLE mentions DROP COLUMN tenant_id');
  await knex.raw('ALTER TABLE messages DROP COLUMN tenant_id');
  await knex.raw('ALTER TABLE contacts DROP COLUMN tenant_id');
  await knex.raw('ALTER TABLE chats DROP COLUMN tenant_id');

  // Recriar FKs originais (estado baseline)
  await knex.raw(`ALTER TABLE messages
    ADD CONSTRAINT messages_ibfk_1 FOREIGN KEY (chat_id) REFERENCES chats (id),
    ADD CONSTRAINT messages_ibfk_2 FOREIGN KEY (contact_id) REFERENCES contacts (id),
    ADD CONSTRAINT messages_ibfk_3 FOREIGN KEY (wid) REFERENCES instances (wid)`);
  await knex.raw(`ALTER TABLE mentions
    ADD CONSTRAINT mentions_ibfk_1 FOREIGN KEY (message_id) REFERENCES messages (id)`);
};
