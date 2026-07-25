// Restrição por tenant. Superadmin => sem cláusula.
export function tenantFilter(auth, alias = '') {
  if (auth.role === 'superadmin') return { sql: '', params: [] };
  return { sql: `${alias}tenant_id = ?`, params: [auth.tenantId] };
}

// Conjunto de instâncias visíveis para o usuário.
// admin/superadmin => 'ALL' (o filtro de tenant já basta).
// gestor => instâncias dos usuários-membros das equipes que ele gerencia (derivado do dono).
// usuario => as próprias (owner_user_id = ele).
export async function visibleInstanceIds(pool, auth) {
  if (auth.role === 'superadmin' || auth.role === 'admin') return 'ALL';

  if (auth.role === 'gestor') {
    const [rows] = await pool.query(
      `SELECT DISTINCT si.id
       FROM team_managers tm
       JOIN teams t ON t.id = tm.team_id
       JOIN team_users tu ON tu.team_id = tm.team_id
       JOIN sentinela_instances si ON si.owner_user_id = tu.user_id
       WHERE tm.user_id = ? AND t.tenant_id = ?`,
      [auth.userId, auth.tenantId]);
    return rows.map(r => r.id);
  }

  // usuario
  const [rows] = await pool.query(
    'SELECT id FROM sentinela_instances WHERE owner_user_id = ? AND tenant_id = ?',
    [auth.userId, auth.tenantId]);
  return rows.map(r => r.id);
}
