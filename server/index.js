import express from 'express';
import 'dotenv/config';
import pool from './db.js';
import { corsMiddleware } from './config/cors.js';
import { authenticate } from './middleware/authenticate.js';
import { createAuthRouter } from './routes/auth.js';
import { createInstancesRouter } from './routes/instances.js';
import { createTenantsRouter } from './routes/tenants.js';
import { createUsersRouter } from './routes/users.js';

export function createApp(dbPool = pool) {
  const app = express();
  // Atrás do nginx/Traefik: confia em 1 hop de proxy para que req.ip seja o IP
  // real do cliente (rate limiting por IP correto).
  app.set('trust proxy', 1);
  app.use(corsMiddleware);
  app.use(express.json());

  // Rotas públicas
  app.use('/api/auth', createAuthRouter(dbPool));

  // Rotas protegidas (JWT + tenant scope)
  app.use('/api/instances', authenticate, createInstancesRouter(dbPool));
  app.use('/api/tenants', authenticate, createTenantsRouter(dbPool));
  app.use('/api/users', authenticate, createUsersRouter(dbPool));

  return app;
}

// Bootstrap somente quando executado diretamente
const isDirectRun = process.argv[1] && process.argv[1].endsWith('index.js');
if (isDirectRun) {
  const port = process.env.PORT || 3001;
  createApp().listen(port, () => {
    console.log(`Sentinela Backend API running on port ${port}`);
  });
}
