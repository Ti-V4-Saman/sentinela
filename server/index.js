import express from 'express';
import 'dotenv/config';
import pool from './db.js';
import { corsMiddleware } from './config/cors.js';
import { authenticate } from './middleware/authenticate.js';
import { createAuthRouter } from './routes/auth.js';
import { createInstancesRouter } from './routes/instances.js';
import { createTenantsRouter } from './routes/tenants.js';
import { createUsersRouter } from './routes/users.js';
import { createTeamsRouter } from './routes/teams.js';
import { createProfileRouter } from './routes/profile.js';
import { createChatsRouter } from './routes/chats.js';
import { createContactTypesRouter } from './routes/contactTypes.js';
import { createContactsRouter } from './routes/contacts.js';
import { createClientsRouter } from './routes/clients.js';

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
  // /me antes de /:id para não cair no router de gestão (restrito a admin).
  app.use('/api/users/me', authenticate, createProfileRouter(dbPool));
  app.use('/api/users', authenticate, createUsersRouter(dbPool));
  app.use('/api/teams', authenticate, createTeamsRouter(dbPool));
  app.use('/api/chats', authenticate, createChatsRouter(dbPool));
  // /api/contact-types antes de /api/contacts (rotas distintas, sem colisão de prefixo).
  app.use('/api/contact-types', authenticate, createContactTypesRouter(dbPool));
  app.use('/api/contacts', authenticate, createContactsRouter(dbPool));
  app.use('/api/clients', authenticate, createClientsRouter(dbPool));

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
