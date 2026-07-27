import express from 'express';
import { requireActor } from '../middleware/actor.js';

// Consulta paginada de access_logs (Fase 6). RBAC: admin (só o próprio tenant), superadmin (global ou
// filtrando por tenant_id). Gestor/usuário NÃO acessam. Não retorna conteúdo sensível (os logs já são
// gravados sem conteúdo de mensagem/token/senha).

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parsePaging(q) {
  let limit = parseInt(q.limit, 10);
  if (Number.isNaN(limit) || limit < 1) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;
  let page = parseInt(q.page, 10);
  if (Number.isNaN(page) || page < 1) page = 1;
  return { page, limit, offset: (page - 1) * limit };
}

export function createAuditRouter(pool) {
  const router = express.Router();
  router.use(requireActor(pool, ['admin', 'superadmin']));

  router.get('/', async (req, res) => {
    try {
      const { page, limit, offset } = parsePaging(req.query);
      const where = []; const args = [];
      // Isolamento por tenant.
      if (req.actor.role !== 'superadmin') { where.push('al.tenant_id = ?'); args.push(req.actor.tenant_id); }
      else if (req.query.tenant_id) { where.push('al.tenant_id = ?'); args.push(req.query.tenant_id); }
      // Filtros opcionais.
      if (req.query.action) { where.push('al.action = ?'); args.push(String(req.query.action)); }
      if (req.query.resource) { where.push('al.resource = ?'); args.push(String(req.query.resource)); }
      if (req.query.actor_user_id) { where.push('al.actor_user_id = ?'); args.push(req.query.actor_user_id); }
      if (DATE_RE.test(req.query.from || '')) { where.push('al.created_at >= ?'); args.push(`${req.query.from} 00:00:00`); }
      if (DATE_RE.test(req.query.to || '')) { where.push('al.created_at < DATE_ADD(?, INTERVAL 1 DAY)'); args.push(`${req.query.to} 00:00:00`); }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const [[cnt]] = await pool.query(`SELECT COUNT(*) total FROM access_logs al ${clause}`, args);
      const [rows] = await pool.query(
        `SELECT al.id, al.tenant_id, al.actor_user_id, al.actor_role, u.name actor_name,
                al.action, al.resource, al.resource_id, al.status, al.ip, al.metadata, al.created_at
         FROM access_logs al LEFT JOIN users u ON u.id = al.actor_user_id
         ${clause} ORDER BY al.created_at DESC, al.id DESC LIMIT ? OFFSET ?`, [...args, limit, offset]);

      const includeTenant = req.actor.role === 'superadmin';
      res.json({
        page, limit, total: Number(cnt.total),
        logs: rows.map((r) => ({
          id: r.id,
          ...(includeTenant ? { tenantId: r.tenant_id } : {}),
          actor: r.actor_user_id ? { id: r.actor_user_id, name: r.actor_name || null, role: r.actor_role || null } : null,
          action: r.action, resource: r.resource, resourceId: r.resource_id || null,
          status: r.status, ip: r.ip || null,
          metadata: r.metadata ?? null,
          createdAt: r.created_at,
        })),
      });
    } catch (e) {
      console.error('list audit:', e);
      res.status(500).json({ error: 'Falha ao carregar a auditoria' });
    }
  });

  return router;
}
