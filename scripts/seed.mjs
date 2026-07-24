import 'dotenv/config';
import mysql from 'mysql2/promise';
import { hashPassword } from '../server/auth/password.js';

const pass = process.env.SEED_SUPERADMIN_PASSWORD;
const emailAdmin = process.env.SEED_SUPERADMIN_EMAIL || 'admin@sentinela.local';
if (!pass) { console.error('Defina SEED_SUPERADMIN_PASSWORD'); process.exit(1); }

const pool = mysql.createPool({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});

await pool.query("INSERT IGNORE INTO tenants (name) VALUES ('V4Company')");
const hash = await hashPassword(pass);
await pool.query(
  `INSERT INTO users (tenant_id, name, email, password_hash, role, status)
   VALUES (NULL, 'Superadmin', ?, ?, 'superadmin', 'active')
   ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)`,
  [emailAdmin, hash]);
console.log('Seed OK');
await pool.end();
