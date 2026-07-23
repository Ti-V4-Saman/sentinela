import express from 'express';
import { tenantFilter, visibleInstanceIds, assertTenantMatch } from '../middleware/tenantScope.js';

const formatInstance = (row) => ({
  id: row.id,
  tenantId: row.tenant_id,
  name: row.name,
  token: row.token,
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
      res.json(rows.map(formatInstance));
    } catch (e) {
      console.error('list instances:', e);
      res.status(e.statusCode || 500).json({ error: 'Falha ao listar instâncias' });
    }
  });

  // POST (admin/superadmin só)
  router.post('/', async (req, res) => {
    if (!['admin', 'superadmin'].includes(req.auth.role)) {
      return res.status(403).json({ error: 'Sem permissão para criar instância' });
    }
    const { id, name, token, status, phoneNumber, contactName, avatarUrl, webhookUrl } = req.body || {};
    const tenantId = req.auth.role === 'superadmin' ? req.body.tenantId : req.auth.tenantId;
    if (!id || !name || !token || !tenantId) {
      return res.status(400).json({ error: 'id, name, token e tenantId são obrigatórios' });
    }
    try {
      await pool.query(
        `INSERT INTO sentinela_instances
         (id, tenant_id, name, token, status, phone_number, contact_name, avatar_url, webhook_url)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [id, tenantId, name, token, status || 'Disconnected',
         phoneNumber || null, contactName || null, avatarUrl || null, webhookUrl || null]);
      const [rows] = await pool.query('SELECT * FROM sentinela_instances WHERE id = ?', [id]);
      res.status(201).json(formatInstance(rows[0]));
    } catch (e) {
      console.error('create instance:', e);
      res.status(500).json({ error: 'Falha ao criar instância' });
    }
  });

  // PUT (dentro do tenant; valida propriedade)
  router.put('/:id', async (req, res) => {
    const { id } = req.params;
    try {
      const [owned] = await pool.query('SELECT tenant_id FROM sentinela_instances WHERE id = ?', [id]);
      if (owned.length === 0) return res.status(404).json({ error: 'Instância não encontrada' });
      assertTenantMatch(req.auth, owned[0].tenant_id);

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
      res.json(formatInstance(rows[0]));
    } catch (e) {
      if (e.statusCode === 403) return res.status(403).json({ error: e.message });
      console.error('update instance:', e);
      res.status(500).json({ error: 'Falha ao atualizar instância' });
    }
  });

  // DELETE (admin/superadmin, dentro do tenant)
  router.delete('/:id', async (req, res) => {
    if (!['admin', 'superadmin'].includes(req.auth.role)) {
      return res.status(403).json({ error: 'Sem permissão' });
    }
    const { id } = req.params;
    try {
      const [owned] = await pool.query('SELECT tenant_id FROM sentinela_instances WHERE id = ?', [id]);
      if (owned.length === 0) return res.status(404).json({ error: 'Instância não encontrada' });
      assertTenantMatch(req.auth, owned[0].tenant_id);
      await pool.query('DELETE FROM sentinela_instances WHERE id = ?', [id]);
      res.json({ success: true, message: 'Instância removida' });
    } catch (e) {
      if (e.statusCode === 403) return res.status(403).json({ error: e.message });
      console.error('delete instance:', e);
      res.status(500).json({ error: 'Falha ao remover instância' });
    }
  });

  return router;
}
