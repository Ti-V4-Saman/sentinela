import cors from 'cors';

function allowlist() {
  return (process.env.CORS_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
}

export const corsMiddleware = cors({
  origin(origin, cb) {
    // Requests sem Origin (curl, server-to-server) são permitidas.
    if (!origin) return cb(null, true);
    return cb(null, allowlist().includes(origin));
  },
  credentials: true,
});
