// Recarrega o usuário atuante do banco (verdade atual de role/status/tenant),
// em vez de confiar no que veio no JWT (que vive até JWT_EXPIRES_IN). Fecha a
// janela em que um admin rebaixado/desativado ainda teria poder pelo token antigo.
export async function loadActor(pool, userId) {
  const [rows] = await pool.query(
    'SELECT id, role, status, tenant_id FROM users WHERE id = ?', [userId]);
  return rows[0] || null;
}

export const isAdmin = (role) => role === 'admin' || role === 'superadmin';

// Middleware factory: exige usuário ativo e (opcionalmente) um dos papéis dados.
// Popula req.actor com {id, role, status, tenant_id}. Rode DEPOIS de `authenticate`.
export function requireActor(pool, allowedRoles = null) {
  return async (req, res, next) => {
    try {
      const actor = await loadActor(pool, req.auth.userId);
      if (!actor || actor.status !== 'active') {
        return res.status(401).json({ error: 'Sessão inválida ou usuário desativado' });
      }
      if (allowedRoles && !allowedRoles.includes(actor.role)) {
        return res.status(403).json({ error: 'Sem permissão' });
      }
      req.actor = actor;
      return next();
    } catch (e) {
      console.error('requireActor:', e);
      return res.status(500).json({ error: 'Erro interno' });
    }
  };
}
