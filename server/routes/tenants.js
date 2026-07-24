import express from 'express';
import { requireActor } from '../middleware/actor.js';

const formatTenant = (r) => ({
  id: r.id,
  name: r.name,
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const VALID_STATUS = ['active', 'suspended'];

export function createTenantsRouter(pool) {
  const router = express.Router();

  // Toda gestão de tenant é exclusiva do superadmin (papel recarregado do banco).
  router.use(requireActor(pool, ['superadmin']));

  router.get('/', async (_req, res) => {
    try {
      const [rows] = await pool.query('SELECT * FROM tenants ORDER BY created_at DESC');
      res.json(rows.map(formatTenant));
    } catch (e) {
      console.error('list tenants:', e);
      res.status(500).json({ error: 'Falha ao listar tenants' });
    }
  });

  router.post('/', async (req, res) => {
    const { name, status } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name é obrigatório' });
    if (status && !VALID_STATUS.includes(status)) return res.status(400).json({ error: 'status inválido' });
    try {
      const [r] = await pool.query(
        'INSERT INTO tenants (name, status) VALUES (?, ?)', [name.trim(), status || 'active']);
      const [rows] = await pool.query('SELECT * FROM tenants WHERE id = ?', [r.insertId]);
      res.status(201).json(formatTenant(rows[0]));
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Já existe tenant com esse nome' });
      console.error('create tenant:', e);
      res.status(500).json({ error: 'Falha ao criar tenant' });
    }
  });

  router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const { name, status } = req.body || {};
    if (status !== undefined && !VALID_STATUS.includes(status)) {
      return res.status(400).json({ error: 'status inválido' });
    }
    const updates = [], values = [];
    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ error: 'name inválido' });
      updates.push('name = ?'); values.push(name.trim());
    }
    if (status !== undefined) { updates.push('status = ?'); values.push(status); }
    if (updates.length === 0) return res.status(400).json({ error: 'Nada para atualizar' });
    values.push(id);
    try {
      const [r] = await pool.query(`UPDATE tenants SET ${updates.join(', ')} WHERE id = ?`, values);
      if (r.affectedRows === 0) return res.status(404).json({ error: 'Tenant não encontrado' });
      const [rows] = await pool.query('SELECT * FROM tenants WHERE id = ?', [id]);
      res.json(formatTenant(rows[0]));
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Já existe tenant com esse nome' });
      console.error('update tenant:', e);
      res.status(500).json({ error: 'Falha ao atualizar tenant' });
    }
  });

  router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    try {
      const [r] = await pool.query('DELETE FROM tenants WHERE id = ?', [id]);
      if (r.affectedRows === 0) return res.status(404).json({ error: 'Tenant não encontrado' });
      res.json({ success: true, message: 'Tenant removido' });
    } catch (e) {
      // FK RESTRICT de instances/sentinela_instances.tenant_id → tenant com instâncias não é removível.
      if (e.errno === 1451 || e.code === 'ER_ROW_IS_REFERENCED_2') {
        return res.status(409).json({ error: 'Tenant possui instâncias vinculadas; remova-as antes' });
      }
      console.error('delete tenant:', e);
      res.status(500).json({ error: 'Falha ao remover tenant' });
    }
  });

  return router;
}
