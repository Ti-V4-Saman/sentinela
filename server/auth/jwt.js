import jwt from 'jsonwebtoken';

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET não configurado');
  return s;
}

export function signToken({ userId, tenantId, role }) {
  return jwt.sign(
    { userId, tenantId: tenantId ?? null, role },
    secret(),
    { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
  );
}

export function verifyToken(token) {
  return jwt.verify(token, secret());
}
