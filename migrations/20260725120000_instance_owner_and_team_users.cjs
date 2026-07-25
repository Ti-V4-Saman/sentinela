// Fase 3: dono da instância + membros de equipe (usuários).
// Verificado: 0 instâncias e 0 vínculos em team_instances no banco → migration segura.
exports.up = async (knex) => {
  // owner_user_id: dono (criador) da instância. NOT NULL — toda instância nova tem dono.
  // ON DELETE RESTRICT: instâncias NUNCA são apagadas ao remover usuário; desativa-se o usuário.
  // (A app garante que o dono pertence ao mesmo tenant da instância.)
  await knex.raw(`ALTER TABLE sentinela_instances
    ADD COLUMN owner_user_id BIGINT UNSIGNED NOT NULL AFTER tenant_id,
    ADD KEY idx_si_owner (owner_user_id),
    ADD CONSTRAINT fk_si_owner FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE RESTRICT`);

  // team_users: usuários-membros da equipe. As instâncias da equipe são DERIVADAS
  // dos donos-membros (não há vínculo manual instância↔equipe).
  await knex.raw(`
    CREATE TABLE team_users (
      team_id BIGINT UNSIGNED NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (team_id, user_id),
      KEY idx_tu_user (user_id),
      CONSTRAINT fk_tu_team FOREIGN KEY (team_id) REFERENCES teams (id) ON DELETE CASCADE,
      CONSTRAINT fk_tu_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

  // NOTA: team_instances e user_instances ficam APOSENTADAS (mantidas no banco, sem uso).
};

exports.down = async (knex) => {
  await knex.raw('DROP TABLE IF EXISTS team_users');
  await knex.raw('ALTER TABLE sentinela_instances DROP FOREIGN KEY fk_si_owner, DROP KEY idx_si_owner, DROP COLUMN owner_user_id');
};
