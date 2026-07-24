import 'dotenv/config';
import mysql from 'mysql2/promise';

const conn = await mysql.createConnection({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});

const [tables] = await conn.query(
  `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME`);
console.log('TABELAS:', tables.map(t => t.TABLE_NAME).join(', '));

for (const t of ['chats','contacts','messages']) {
  const [pk] = await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX`, [t]);
  console.log(`PK ${t}:`, pk.map(r => r.COLUMN_NAME).join(', '));
}

const [fks] = await conn.query(
  `SELECT TABLE_NAME, CONSTRAINT_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION) cols,
          REFERENCED_TABLE_NAME rt
   FROM information_schema.KEY_COLUMN_USAGE
   WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL
   GROUP BY TABLE_NAME, CONSTRAINT_NAME, REFERENCED_TABLE_NAME ORDER BY TABLE_NAME`);
console.log('\nFKs:');
for (const f of fks) console.log(`  ${f.TABLE_NAME}.[${f.cols}] -> ${f.rt} (${f.CONSTRAINT_NAME})`);

const [ver] = await conn.query('SELECT name FROM knex_migrations ORDER BY id');
console.log('\nMIGRATIONS aplicadas:', ver.length);

await conn.end();
