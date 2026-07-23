require('dotenv').config();

/** @type {import('knex').Knex.Config} */
module.exports = {
  development: {
    client: 'mysql2',
    connection: {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    },
    migrations: {
      directory: './migrations',
      tableName: 'knex_migrations',
      // Projeto é ESM ("type":"module"); migrations usam CommonJS (exports.up),
      // então precisam ser .cjs — senão o Node trata como ESM e `exports` quebra.
      extension: 'cjs',
      loadExtensions: ['.cjs'],
    },
    pool: { min: 0, max: 10 },
  },
};
