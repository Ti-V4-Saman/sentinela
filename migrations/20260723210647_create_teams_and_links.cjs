// teams.tenant_id -> tenants CASCADE. Junções CASCADE em ambas as pontas.
// user_instances: N:N users(role=usuario) <-> sentinela_instances, necessária
// para o escopo do papel "usuario" (ver só os próprios números).
exports.up = async (knex) => {
  await knex.raw(`
    CREATE TABLE teams (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      tenant_id BIGINT UNSIGNED NOT NULL,
      name VARCHAR(150) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_teams_tenant_name (tenant_id, name),
      CONSTRAINT fk_teams_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

  await knex.raw(`
    CREATE TABLE team_managers (
      team_id BIGINT UNSIGNED NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (team_id, user_id),
      KEY idx_tm_user (user_id),
      CONSTRAINT fk_tm_team FOREIGN KEY (team_id) REFERENCES teams (id) ON DELETE CASCADE,
      CONSTRAINT fk_tm_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

  await knex.raw(`
    CREATE TABLE team_instances (
      team_id BIGINT UNSIGNED NOT NULL,
      instance_id VARCHAR(64) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (team_id, instance_id),
      KEY idx_ti_instance (instance_id),
      CONSTRAINT fk_ti_team FOREIGN KEY (team_id) REFERENCES teams (id) ON DELETE CASCADE,
      CONSTRAINT fk_ti_instance FOREIGN KEY (instance_id) REFERENCES sentinela_instances (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

  await knex.raw(`
    CREATE TABLE user_instances (
      user_id BIGINT UNSIGNED NOT NULL,
      instance_id VARCHAR(64) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, instance_id),
      KEY idx_ui_instance (instance_id),
      CONSTRAINT fk_ui_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
      CONSTRAINT fk_ui_instance FOREIGN KEY (instance_id) REFERENCES sentinela_instances (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
};

exports.down = async (knex) => {
  await knex.raw('DROP TABLE IF EXISTS user_instances');
  await knex.raw('DROP TABLE IF EXISTS team_instances');
  await knex.raw('DROP TABLE IF EXISTS team_managers');
  await knex.raw('DROP TABLE IF EXISTS teams');
};
