import express from 'express';
import { hashPassword } from '../auth/password.js';

const formatUser = (r) => ({
  id: r.id, tenantId: r.tenant_id, name: r.name, email: r.email, role: r.role, status: r.status,
});

// Auto-atualização de perfil (qualquer papel autenticado).
// SEMPRE o usuário do JWT (req.auth.userId) — nunca um id vindo do corpo.
// Aceita `name` e (opcional) `password`. Ignora email/role/tenant_id de propósito.
export function createProfileRouter(pool) {
  const router = express.Router();

  router.patch('/', async (req, res) => {
    const { name, password } = req.body || {};
    const updates = [], values = [];

    if (name !== undefined) {
      if (!String(name).trim()) return res.status(400).json({ error: 'Informe seu nome' });
      updates.push('name = ?'); values.push(String(name).trim());
    }
    if (password !== undefined && password !== '') {
      if (String(password).length < 8) {
        return res.status(400).json({ error: 'A senha precisa ter no mínimo 8 caracteres' });
      }
      updates.push('password_hash = ?'); values.push(await hashPassword(password));
    }
    if (updates.length === 0) return res.status(400).json({ error: 'Nada para atualizar' });

    values.push(req.auth.userId);
    try {
      await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);
      const [rows] = await pool.query(
        'SELECT id, tenant_id, name, email, role, status FROM users WHERE id = ?', [req.auth.userId]);
      res.json(formatUser(rows[0]));
    } catch (e) {
      console.error('update profile:', e);
      res.status(500).json({ error: 'Falha ao atualizar perfil' });
    }
  });

  return router;
}
