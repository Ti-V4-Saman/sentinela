import express from 'express';
import { tenantFilter, visibleInstanceIds } from '../middleware/tenantScope.js';
import { loadActor, isAdmin } from '../middleware/actor.js';

// includeToken controla exposição do token QuePasa (credencial sensível):
// só admin/superadmin recebem; gestor/usuario (read-only) não.
const formatInstance = (row, { includeToken = false } = {}) => ({
  id: row.id,
  tenantId: row.tenant_id,
  name: row.name,
  ...(includeToken ? { token: row.token } : {}),
  status: row.status,
  phoneNumber: row.phone_number || '',
  contactName: row.contact_name || '',
  avatarUrl: row.avatar_url || '',
  webhookUrl: row.webhook_url || '',
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export function createInstancesRouter(pool) {
  const router = express.Router();

  // GET all (tenant + role scoped)
  router.get('/', async (req, res) => {
    try {
      const { sql: tSql, params } = tenantFilter(req.auth);
      const visible = await visibleInstanceIds(pool, req.auth);

      const where = [];
      const args = [];
      if (tSql) { where.push(tSql); args.push(...params); }
      if (visible !== 'ALL') {
        if (visible.length === 0) return res.json([]);
        where.push(`id IN (${visible.map(() => '?').join(',')})`);
        args.push(...visible);
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const [rows] = await pool.query(
        `SELECT * FROM sentinela_instances ${clause} ORDER BY created_at DESC`, args);
      const includeToken = isAdmin(req.auth.role);
      res.json(rows.map((r) => formatInstance(r, { includeToken })));
    } catch (e) {
      console.error('list instances:', e);
      res.status(e.statusCode || 500).json({ error: 'Falha ao listar instâncias' });
    }
  });

  // POST (admin/superadmin só; papel/status recarregados do banco)
  router.post('/', async (req, res) => {
    try {
      const actor = await loadActor(pool, req.auth.userId);
      if (!actor || actor.status !== 'active') {
        return res.status(401).json({ error: 'Sessão inválida ou usuário desativado' });
      }
      if (!isAdmin(actor.role)) {
        return res.status(403).json({ error: 'Sem permissão para criar instância' });
      }
      const { id, name, token, status, phoneNumber, contactName, avatarUrl, webhookUrl } = req.body || {};
      const tenantId = actor.role === 'superadmin' ? req.body.tenantId : actor.tenant_id;
      if (!id || !name || !token || !tenantId) {
        return res.status(400).json({ error: 'id, name, token e tenantId são obrigatórios' });
      }
      // Valida existência do tenant (superadmin fornece via body) para retornar 400, não 500.
      const [t] = await pool.query('SELECT id FROM tenants WHERE id = ?', [tenantId]);
      if (t.length === 0) return res.status(400).json({ error: 'tenantId inexistente' });

      await pool.query(
        `INSERT INTO sentinela_instances
         (id, tenant_id, name, token, status, phone_number, contact_name, avatar_url, webhook_url)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [id, tenantId, name, token, status || 'Disconnected',
         phoneNumber || null, contactName || null, avatarUrl || null, webhookUrl || null]);
      const [rows] = await pool.query('SELECT * FROM sentinela_instances WHERE id = ?', [id]);
      res.status(201).json(formatInstance(rows[0], { includeToken: true }));
    } catch (e) {
      console.error('create instance:', e);
      res.status(500).json({ error: 'Falha ao criar instância' });
    }
  });

  // PUT (admin/superadmin só; dentro do tenant). Gestão de instância é papel do admin;
  // gestor/usuario são read-only. Instância de outro tenant → 404 (não 403), para não
  // revelar existência de IDs em outros tenants.
  router.put('/:id', async (req, res) => {
    const { id } = req.params;
    try {
      const actor = await loadActor(pool, req.auth.userId);
      if (!actor || actor.status !== 'active') {
        return res.status(401).json({ error: 'Sessão inválida ou usuário desativado' });
      }
      if (!isAdmin(actor.role)) {
        return res.status(403).json({ error: 'Sem permissão para alterar instância' });
      }
      const [owned] = await pool.query('SELECT tenant_id FROM sentinela_instances WHERE id = ?', [id]);
      if (owned.length === 0) return res.status(404).json({ error: 'Instância não encontrada' });
      if (actor.role !== 'superadmin' && Number(owned[0].tenant_id) !== Number(actor.tenant_id)) {
        return res.status(404).json({ error: 'Instância não encontrada' });
      }

      const map = {
        name: 'name', token: 'token', status: 'status',
        phoneNumber: 'phone_number', contactName: 'contact_name',
        avatarUrl: 'avatar_url', webhookUrl: 'webhook_url',
      };
      const updates = [], values = [];
      for (const [k, col] of Object.entries(map)) {
        if (req.body[k] !== undefined) { updates.push(`${col} = ?`); values.push(req.body[k]); }
      }
      if (updates.length === 0) return res.status(400).json({ error: 'Nada para atualizar' });
      values.push(id);
      await pool.query(`UPDATE sentinela_instances SET ${updates.join(', ')} WHERE id = ?`, values);
      const [rows] = await pool.query('SELECT * FROM sentinela_instances WHERE id = ?', [id]);
      res.json(formatInstance(rows[0], { includeToken: true }));
    } catch (e) {
      console.error('update instance:', e);
      res.status(500).json({ error: 'Falha ao atualizar instância' });
    }
  });

  // DELETE (admin/superadmin, dentro do tenant; outro tenant → 404)
  router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    try {
      const actor = await loadActor(pool, req.auth.userId);
      if (!actor || actor.status !== 'active') {
        return res.status(401).json({ error: 'Sessão inválida ou usuário desativado' });
      }
      if (!isAdmin(actor.role)) {
        return res.status(403).json({ error: 'Sem permissão' });
      }
      const [owned] = await pool.query('SELECT tenant_id FROM sentinela_instances WHERE id = ?', [id]);
      if (owned.length === 0) return res.status(404).json({ error: 'Instância não encontrada' });
      if (actor.role !== 'superadmin' && Number(owned[0].tenant_id) !== Number(actor.tenant_id)) {
        return res.status(404).json({ error: 'Instância não encontrada' });
      }
      await pool.query('DELETE FROM sentinela_instances WHERE id = ?', [id]);
      res.json({ success: true, message: 'Instância removida' });
    } catch (e) {
      console.error('delete instance:', e);
      res.status(500).json({ error: 'Falha ao remover instância' });
    }
  });

  return router;
}
