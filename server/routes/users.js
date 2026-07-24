import express from 'express';
import { requireActor } from '../middleware/actor.js';
import { hashPassword } from '../auth/password.js';

const ROLES = ['superadmin', 'admin', 'gestor', 'usuario'];
const VALID_STATUS = ['active', 'disabled'];

// Nunca expõe password_hash.
const formatUser = (r) => ({
  id: r.id,
  tenantId: r.tenant_id,
  name: r.name,
  email: r.email,
  role: r.role,
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function createUsersRouter(pool) {
  const router = express.Router();
  router.use(requireActor(pool, ['admin', 'superadmin']));

  // GET — admin vê só usuários do próprio tenant; superadmin vê todos (ou ?tenantId=).
  router.get('/', async (req, res) => {
    try {
      const where = [], args = [];
      if (req.actor.role !== 'superadmin') {
        where.push('tenant_id = ?'); args.push(req.actor.tenant_id);
      } else if (req.query.tenantId) {
        where.push('tenant_id = ?'); args.push(req.query.tenantId);
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const [rows] = await pool.query(
        `SELECT id, tenant_id, name, email, role, status, created_at, updated_at
         FROM users ${clause} ORDER BY created_at DESC`, args);
      res.json(rows.map(formatUser));
    } catch (e) {
      console.error('list users:', e);
      res.status(500).json({ error: 'Falha ao listar usuários' });
    }
  });

  // POST — cria usuário. Admin: só no próprio tenant e não pode criar superadmin.
  router.post('/', async (req, res) => {
    const { name, email, password, role, status } = req.body || {};
    if (!name || !name.trim() || !email || !email.trim() || !password) {
      return res.status(400).json({ error: 'name, email e password são obrigatórios' });
    }
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'role inválido' });
    if (status && !VALID_STATUS.includes(status)) return res.status(400).json({ error: 'status inválido' });

    // Resolve tenant_id e restrições por papel do atuante.
    let tenantId;
    if (req.actor.role === 'superadmin') {
      if (role === 'superadmin') {
        tenantId = null;
      } else {
        tenantId = req.body.tenantId;
        if (!tenantId) return res.status(400).json({ error: 'tenantId é obrigatório para papéis não-superadmin' });
        const [t] = await pool.query('SELECT id FROM tenants WHERE id = ?', [tenantId]);
        if (t.length === 0) return res.status(400).json({ error: 'tenantId inexistente' });
      }
    } else {
      // admin
      if (role === 'superadmin') return res.status(403).json({ error: 'Admin não pode criar superadmin' });
      tenantId = req.actor.tenant_id; // sempre o próprio tenant
    }

    try {
      const hash = await hashPassword(password);
      const [r] = await pool.query(
        `INSERT INTO users (tenant_id, name, email, password_hash, role, status)
         VALUES (?,?,?,?,?,?)`,
        [tenantId, name.trim(), email.trim(), hash, role, status || 'active']);
      const [rows] = await pool.query(
        'SELECT id, tenant_id, name, email, role, status, created_at, updated_at FROM users WHERE id = ?', [r.insertId]);
      res.status(201).json(formatUser(rows[0]));
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Já existe usuário com esse email' });
      console.error('create user:', e);
      res.status(500).json({ error: 'Falha ao criar usuário' });
    }
  });

  // Carrega o usuário-alvo respeitando o escopo do atuante. Fora de escopo => null (404).
  async function loadTargetInScope(actor, id) {
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [id]);
    const target = rows[0];
    if (!target) return null;
    if (actor.role !== 'superadmin' && Number(target.tenant_id) !== Number(actor.tenant_id)) return null;
    return target;
  }

  // PUT — atualiza. Admin não pode promover a superadmin nem mudar tenant.
  router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const { name, email, password, role, status } = req.body || {};
    if (role !== undefined && !ROLES.includes(role)) return res.status(400).json({ error: 'role inválido' });
    if (status !== undefined && !VALID_STATUS.includes(status)) return res.status(400).json({ error: 'status inválido' });
    if (role === 'superadmin' && req.actor.role !== 'superadmin') {
      return res.status(403).json({ error: 'Admin não pode promover a superadmin' });
    }
    try {
      const target = await loadTargetInScope(req.actor, id);
      if (!target) return res.status(404).json({ error: 'Usuário não encontrado' });

      const updates = [], values = [];
      if (name !== undefined) { if (!name.trim()) return res.status(400).json({ error: 'name inválido' }); updates.push('name = ?'); values.push(name.trim()); }
      if (email !== undefined) { if (!email.trim()) return res.status(400).json({ error: 'email inválido' }); updates.push('email = ?'); values.push(email.trim()); }
      if (role !== undefined) { updates.push('role = ?'); values.push(role); }
      if (status !== undefined) { updates.push('status = ?'); values.push(status); }
      if (password !== undefined) { updates.push('password_hash = ?'); values.push(await hashPassword(password)); }
      if (updates.length === 0) return res.status(400).json({ error: 'Nada para atualizar' });
      values.push(id);

      await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);
      const [rows] = await pool.query(
        'SELECT id, tenant_id, name, email, role, status, created_at, updated_at FROM users WHERE id = ?', [id]);
      res.json(formatUser(rows[0]));
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Já existe usuário com esse email' });
      console.error('update user:', e);
      res.status(500).json({ error: 'Falha ao atualizar usuário' });
    }
  });

  // DELETE — não permite remover a própria conta.
  router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    if (Number(id) === Number(req.actor.id)) {
      return res.status(400).json({ error: 'Não é possível remover a própria conta' });
    }
    try {
      const target = await loadTargetInScope(req.actor, id);
      if (!target) return res.status(404).json({ error: 'Usuário não encontrado' });
      await pool.query('DELETE FROM users WHERE id = ?', [id]);
      res.json({ success: true, message: 'Usuário removido' });
    } catch (e) {
      console.error('delete user:', e);
      res.status(500).json({ error: 'Falha ao remover usuário' });
    }
  });

  return router;
}
