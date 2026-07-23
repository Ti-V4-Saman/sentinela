// tenant_id em instances e sentinela_instances como FK simples (1 instância = 1 tenant).
// ON DELETE RESTRICT: impedir apagar tenant com instâncias ativas sem tratá-las antes.
// NULL permitido temporariamente (não há instância legada; DB atual vazio).
exports.up = async (knex) => {
  await knex.raw(`ALTER TABLE sentinela_instances
    ADD COLUMN tenant_id BIGINT UNSIGNED NULL AFTER id,
    ADD KEY idx_si_tenant (tenant_id),
    ADD CONSTRAINT fk_si_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT`);
  await knex.raw(`ALTER TABLE instances
    ADD COLUMN tenant_id BIGINT UNSIGNED NULL AFTER wid,
    ADD KEY idx_inst_tenant (tenant_id),
    ADD CONSTRAINT fk_inst_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT`);
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE instances DROP FOREIGN KEY fk_inst_tenant, DROP KEY idx_inst_tenant, DROP COLUMN tenant_id');
  await knex.raw('ALTER TABLE sentinela_instances DROP FOREIGN KEY fk_si_tenant, DROP KEY idx_si_tenant, DROP COLUMN tenant_id');
};
