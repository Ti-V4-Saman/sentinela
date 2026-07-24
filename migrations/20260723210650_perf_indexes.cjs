// Índices de performance faltantes (os de messages já existem no baseline).
// tenant_id à esquerda para casar com o padrão de filtro por tenant.
exports.up = async (knex) => {
  await knex.raw('ALTER TABLE contacts ADD KEY idx_contacts_tenant_phone (tenant_id, phone)');
  await knex.raw('ALTER TABLE chats ADD KEY idx_chats_tenant_title (tenant_id, title)');
};
exports.down = async (knex) => {
  await knex.raw('ALTER TABLE chats DROP KEY idx_chats_tenant_title');
  await knex.raw('ALTER TABLE contacts DROP KEY idx_contacts_tenant_phone');
};
