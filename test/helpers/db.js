import 'dotenv/config';
import mysql from 'mysql2/promise';
import knexFactory from 'knex';
import config from '../../knexfile.cjs';

let _pool;
export function getPool() {
  if (!_pool) {
    _pool = mysql.createPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 5,
    });
  }
  return _pool;
}

// Aplica migrations (idempotente). NÃO destrói dados: só cria o que falta.
export async function applyMigrations() {
  const knex = knexFactory(config.development);
  try {
    await knex.migrate.latest();
  } finally {
    await knex.destroy();
  }
}

// Executa fn dentro de uma transação e SEMPRE faz rollback (nada persiste).
// fn recebe uma connection mysql2 (que expõe .query, como um pool).
export async function withTx(fn) {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  await conn.beginTransaction();
  try {
    return await fn(conn);
  } finally {
    try { await conn.rollback(); } catch { /* noop */ }
    await conn.end();
  }
}
