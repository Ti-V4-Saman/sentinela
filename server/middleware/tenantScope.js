// Restrição por tenant. Superadmin => sem cláusula.
export function tenantFilter(auth, alias = '') {
  if (auth.role === 'superadmin') return { sql: '', params: [] };
  return { sql: `${alias}tenant_id = ?`, params: [auth.tenantId] };
}

// Conjunto de instâncias visíveis para o usuário.
// admin/superadmin => 'ALL' (o filtro de tenant já basta).
export async function visibleInstanceIds(pool, auth) {
  if (auth.role === 'superadmin' || auth.role === 'admin') return 'ALL';

  if (auth.role === 'gestor') {
    const [rows] = await pool.query(
      `SELECT DISTINCT ti.instance_id
       FROM team_managers tm
       JOIN team_instances ti ON ti.team_id = tm.team_id
       JOIN teams t ON t.id = tm.team_id
       WHERE tm.user_id = ? AND t.tenant_id = ?`,
      [auth.userId, auth.tenantId]);
    return rows.map(r => r.instance_id);
  }

  // usuario
  const [rows] = await pool.query(
    `SELECT ui.instance_id
     FROM user_instances ui
     JOIN sentinela_instances si ON si.id = ui.instance_id
     WHERE ui.user_id = ? AND si.tenant_id = ?`,
    [auth.userId, auth.tenantId]);
  return rows.map(r => r.instance_id);
}

export function assertTenantMatch(auth, resourceTenantId) {
  if (auth.role === 'superadmin') return;
  if (Number(auth.tenantId) !== Number(resourceTenantId)) {
    const err = new Error('Acesso negado a outro tenant');
    err.statusCode = 403;
    throw err;
  }
}
