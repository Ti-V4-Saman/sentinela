import express from 'express';
import { requireActor } from '../middleware/actor.js';

// Drill-down administrativo de um CLIENTE (tenant). Endpoints SEPARADOS e PAGINADOS por tabela
// (nada de "resposta gigante"). RBAC: superadmin abre qualquer cliente; admin só o PRÓPRIO tenant.
// Acesso cross-tenant → 404 (indistinguível de inexistente). Não retorna tokens/segredos/wid/webhook.

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

function parsePaging(q) {
  let limit = parseInt(q.limit, 10);
  if (Number.isNaN(limit) || limit < 1) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;
  let page = parseInt(q.page, 10);
  if (Number.isNaN(page) || page < 1) page = 1;
  return { page, limit, offset: (page - 1) * limit };
}

export function createClientsRouter(pool) {
  const router = express.Router();
  router.use(requireActor(pool, ['admin', 'superadmin']));

  // Resolve o tenant-alvo respeitando RBAC. Retorna a linha do tenant ou null.
  async function resolveTenant(actor, id) {
    const tid = Number(id);
    if (!Number.isInteger(tid)) return null;
    if (actor.role !== 'superadmin' && tid !== Number(actor.tenant_id)) return null; // admin só o próprio
    const [rows] = await pool.query('SELECT id, name, status, created_at FROM tenants WHERE id = ?', [tid]);
    return rows[0] || null;
  }

  // Carrega e valida o cliente para toda rota com :id (404 sem revelar existência entre tenants).
  router.param('id', async (req, res, next, id) => {
    try {
      const t = await resolveTenant(req.actor, id);
      if (!t) return res.status(404).json({ error: 'Cliente não encontrado' });
      req.client = t;
      return next();
    } catch (e) {
      console.error('resolve client:', e);
      return res.status(500).json({ error: 'Erro interno' });
    }
  });

  // ---- Visão geral / KPIs (agregado, nº fixo de COUNTs — sem N+1) ----
  router.get('/:id/overview', async (req, res) => {
    try {
      const tid = req.client.id;
      const [[inst]] = await pool.query(
        `SELECT COUNT(*) total, SUM(status = 'Connected') connected, SUM(capture_wid IS NOT NULL) mapped
         FROM sentinela_instances WHERE tenant_id = ?`, [tid]);
      const [convRows] = await pool.query(
        `SELECT c.is_group g, COUNT(*) n FROM chats c
         WHERE c.tenant_id = ? AND EXISTS (SELECT 1 FROM messages m WHERE m.tenant_id = c.tenant_id AND m.chat_id = c.id)
         GROUP BY c.is_group`, [tid]);
      const conversations = Number(convRows.find((r) => Number(r.g) === 0)?.n || 0);
      const groups = Number(convRows.find((r) => Number(r.g) === 1)?.n || 0);
      const [userRows] = await pool.query('SELECT role, COUNT(*) n FROM users WHERE tenant_id = ? GROUP BY role', [tid]);
      const byRole = {}; let usersTotal = 0;
      for (const r of userRows) { byRole[r.role] = Number(r.n); usersTotal += Number(r.n); }
      const [[teams]] = await pool.query('SELECT COUNT(*) total FROM teams WHERE tenant_id = ?', [tid]);
      const [[contacts]] = await pool.query(
        'SELECT COUNT(*) total, SUM(identification_source IS NOT NULL) identified FROM contacts WHERE tenant_id = ?', [tid]);
      const [[msgs]] = await pool.query('SELECT COUNT(*) total FROM messages WHERE tenant_id = ?', [tid]);

      const instTotal = Number(inst.total);
      const mapped = Number(inst.mapped || 0);
      const contactsTotal = Number(contacts.total);
      const identified = Number(contacts.identified || 0);
      res.json({
        client: { id: req.client.id, name: req.client.name, status: req.client.status, createdAt: req.client.created_at },
        kpis: {
          instances: { total: instTotal, connected: Number(inst.connected || 0), captureMapped: mapped, captureUnmapped: instTotal - mapped },
          conversations,
          groups,
          users: { total: usersTotal, byRole },
          teams: Number(teams.total),
          contacts: { total: contactsTotal, identified, pending: contactsTotal - identified },
          messages: Number(msgs.total),
        },
      });
    } catch (e) {
      console.error('client overview:', e);
      res.status(500).json({ error: 'Falha ao carregar a visão geral' });
    }
  });

  // ---- Instâncias (paginado) — situação do capture como BOOLEAN (não expõe o wid) ----
  router.get('/:id/instances', async (req, res) => {
    try {
      const { page, limit, offset } = parsePaging(req.query);
      const tid = req.client.id;
      const [[cnt]] = await pool.query('SELECT COUNT(*) total FROM sentinela_instances WHERE tenant_id = ?', [tid]);
      const [rows] = await pool.query(
        `SELECT si.id, si.name, si.status, si.phone_number, si.capture_wid, si.owner_user_id, u.name owner_name,
                (SELECT COUNT(*) FROM team_instances ti WHERE ti.instance_id = si.id) team_count
         FROM sentinela_instances si
         LEFT JOIN users u ON u.id = si.owner_user_id
         WHERE si.tenant_id = ? ORDER BY si.name, si.id LIMIT ? OFFSET ?`, [tid, limit, offset]);
      res.json({
        page, limit, total: Number(cnt.total),
        instances: rows.map((r) => ({
          id: r.id, name: r.name, status: r.status, phoneNumber: r.phone_number || null,
          captureMapped: !!r.capture_wid, // situação do capture_wid (booleano — não expõe o wid)
          owner: r.owner_user_id ? { id: r.owner_user_id, name: r.owner_name || null } : null,
          teamCount: Number(r.team_count),
        })),
      });
    } catch (e) {
      console.error('client instances:', e);
      res.status(500).json({ error: 'Falha ao listar instâncias' });
    }
  });

  // ---- Usuários (paginado) — sem password_hash ----
  router.get('/:id/users', async (req, res) => {
    try {
      const { page, limit, offset } = parsePaging(req.query);
      const tid = req.client.id;
      const [[cnt]] = await pool.query('SELECT COUNT(*) total FROM users WHERE tenant_id = ?', [tid]);
      const [rows] = await pool.query(
        'SELECT id, name, email, role, status, created_at FROM users WHERE tenant_id = ? ORDER BY name, id LIMIT ? OFFSET ?',
        [tid, limit, offset]);
      res.json({
        page, limit, total: Number(cnt.total),
        users: rows.map((r) => ({ id: r.id, name: r.name, email: r.email, role: r.role, status: r.status, createdAt: r.created_at })),
      });
    } catch (e) {
      console.error('client users:', e);
      res.status(500).json({ error: 'Falha ao listar usuários' });
    }
  });

  // ---- Equipes (paginado) — com contagens de vínculos ----
  router.get('/:id/teams', async (req, res) => {
    try {
      const { page, limit, offset } = parsePaging(req.query);
      const tid = req.client.id;
      const [[cnt]] = await pool.query('SELECT COUNT(*) total FROM teams WHERE tenant_id = ?', [tid]);
      const [rows] = await pool.query(
        `SELECT t.id, t.name,
                (SELECT COUNT(*) FROM team_users tu WHERE tu.team_id = t.id) user_count,
                (SELECT COUNT(*) FROM team_managers tm WHERE tm.team_id = t.id) manager_count,
                (SELECT COUNT(*) FROM team_instances ti WHERE ti.team_id = t.id) instance_count
         FROM teams t WHERE t.tenant_id = ? ORDER BY t.name, t.id LIMIT ? OFFSET ?`, [tid, limit, offset]);
      res.json({
        page, limit, total: Number(cnt.total),
        teams: rows.map((r) => ({
          id: r.id, name: r.name,
          userCount: Number(r.user_count), managerCount: Number(r.manager_count), instanceCount: Number(r.instance_count),
        })),
      });
    } catch (e) {
      console.error('client teams:', e);
      res.status(500).json({ error: 'Falha ao listar equipes' });
    }
  });

  // ---- Contatos (paginado + status identificado/pendente) ----
  router.get('/:id/contacts', async (req, res) => {
    try {
      const { page, limit, offset } = parsePaging(req.query);
      const tid = req.client.id;
      const status = (req.query.status || '').trim();
      const where = ['c.tenant_id = ?']; const args = [tid];
      if (status === 'identified') where.push('c.identification_source IS NOT NULL');
      else if (status === 'pending') where.push('c.identification_source IS NULL');
      const clause = `WHERE ${where.join(' AND ')}`;
      const [[cnt]] = await pool.query(`SELECT COUNT(*) total FROM contacts c ${clause}`, args);
      const [rows] = await pool.query(
        `SELECT c.id, c.name, c.display_name, c.phone, c.identification_source,
                c.contact_type_id, cty.name type_name, cty.color type_color
         FROM contacts c
         LEFT JOIN contact_types cty ON cty.tenant_id = c.tenant_id AND cty.id = c.contact_type_id
         ${clause}
         ORDER BY (c.display_name IS NULL AND c.name IS NULL), COALESCE(c.display_name, c.name, c.phone), c.id
         LIMIT ? OFFSET ?`, [...args, limit, offset]);
      res.json({
        page, limit, total: Number(cnt.total),
        contacts: rows.map((r) => ({
          id: r.id, name: r.name || null, displayName: r.display_name || null, phone: r.phone || null,
          identified: r.identification_source != null, identificationSource: r.identification_source || null,
          type: r.contact_type_id ? { id: r.contact_type_id, name: r.type_name || null, color: r.type_color || null } : null,
        })),
      });
    } catch (e) {
      console.error('client contacts:', e);
      res.status(500).json({ error: 'Falha ao listar contatos' });
    }
  });

  return router;
}
