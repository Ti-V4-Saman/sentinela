import express from 'express';
import rateLimit from 'express-rate-limit';
import { verifyPassword } from '../auth/password.js';
import { signToken } from '../auth/jwt.js';

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de login. Tente novamente mais tarde.' },
});

export function createAuthRouter(pool) {
  const router = express.Router();

  router.post('/login', loginLimiter, async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email e password obrigatórios' });
    try {
      const [rows] = await pool.query(
        "SELECT id, tenant_id, name, password_hash, role, status FROM users WHERE email = ? LIMIT 1",
        [email]);
      const user = rows[0];
      // Resposta uniforme para não vazar existência do email
      if (!user || user.status !== 'active' || !(await verifyPassword(password, user.password_hash))) {
        return res.status(401).json({ error: 'Credenciais inválidas' });
      }
      const token = signToken({ userId: user.id, tenantId: user.tenant_id, role: user.role });
      return res.json({ token, user: { id: user.id, name: user.name, role: user.role, tenantId: user.tenant_id } });
    } catch (e) {
      console.error('login error:', e);
      return res.status(500).json({ error: 'Erro interno' });
    }
  });

  return router;
}
