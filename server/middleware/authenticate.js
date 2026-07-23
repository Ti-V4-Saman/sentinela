import { verifyToken } from '../auth/jwt.js';

export function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Token ausente' });
  }
  try {
    const payload = verifyToken(token);
    req.auth = { userId: payload.userId, tenantId: payload.tenantId, role: payload.role };
    return next();
  } catch {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }
}
