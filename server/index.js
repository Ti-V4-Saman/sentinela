import express from 'express';
import 'dotenv/config';
import pool from './db.js';
import { corsMiddleware } from './config/cors.js';
import { authenticate } from './middleware/authenticate.js';
import { createAuthRouter } from './routes/auth.js';
import { createInstancesRouter } from './routes/instances.js';

export function createApp(dbPool = pool) {
  const app = express();
  app.use(corsMiddleware);
  app.use(express.json());

  // Rotas públicas
  app.use('/api/auth', createAuthRouter(dbPool));

  // Rotas protegidas (JWT + tenant scope)
  app.use('/api/instances', authenticate, createInstancesRouter(dbPool));

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
