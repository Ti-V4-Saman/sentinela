# Sentinela Fase 1 — Multi-tenant, RBAC, Segurança e Performance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transformar o Sentinela (monitoramento read-only de WhatsApp) num sistema multi-tenant com RBAC de 4 níveis, migrations versionadas (Knex), FKs/índices reconciliados e autenticação JWT com isolamento de tenant aplicado centralmente em toda query.

**Architecture:** Backend Node/Express + `mysql2/promise` (sem ORM no runtime). Knex é adotado **apenas** como ferramenta de migrations (CLI + arquivos `up`/`down`), nunca como query builder de runtime. Isolamento de tenant é **denormalizado**: `tenant_id` vive em todas as tabelas de dados; `contacts`/`chats`/`messages` usam PK composta `(tenant_id, id)`; um middleware central resolve o escopo (tenant + role) e um helper injeta o filtro em toda query. Auth troca a chave estática global `X-Sentinela-Key` por JWT com login por usuário (email+senha, `bcryptjs`).

**Tech Stack:** Node 20, Express 5, mysql2/promise, Knex (migrations), jsonwebtoken, bcryptjs, express-rate-limit, cors; Vitest + Supertest para testes; MySQL 8 (dev compartilhado + container de teste efêmero).

## Global Constraints

- Sistema é e permanece **100% read-only**: nenhuma funcionalidade de envio/resposta de mensagem.
- Engine do banco continua **MySQL 8** (não migrar para Postgres).
- Toda migration reversível (`up`/`down`) sempre que tecnicamente possível.
- **Nenhum segredo real** commitado. `.env` local (já no `.gitignore`). `JWT_SECRET` nunca versionado.
- **Isolamento de tenant é invariante de segurança**: nenhuma rota pode retornar dados de outro tenant, nem por engano. O filtro por `tenant_id` é aplicado por um helper central, não repetido rota a rota.
- Knex é **migrations-only**. Queries de runtime continuam em `mysql2/promise` com SQL parametrizado (`?`), nunca concatenando input.
- **Sanitização/rotação de segredos está ADIADA** para o deploy de produção (valores atuais são de teste/dev). Não é tarefa desta fase — ver seção "Pendências pré-produção".
- Trabalhar em branch dedicada (`feat/fase1-multitenant`), nunca commitar direto na `main`.
- **Migrations rodam primeiro no DB de teste** (container efêmero) e só depois no DB de dev compartilhado (`143.244.156.195`).

**Estado atual verificado (2026-07-23):** DB dev vazio (0 linhas em todas as tabelas). FKs `messages→chats/contacts/instances` e `mentions→messages` já existem. Índices `idx_chat_id/idx_contact_id/idx_timestamp/wid` em `messages` já existem. `instances` (PK `wid`) e `sentinela_instances` (PK `id`) são tabelas separadas com colunas quase idênticas. Repo não tem migration alguma; só `sentinela_instances` é auto-criada em `server/index.js`. Há drift schema↔código.

---

## File Structure

**Novos diretórios/arquivos:**
- `knexfile.cjs` — config Knex (dev + test), lê `.env`.
- `migrations/` — arquivos de migration Knex (timestamped).
- `server/db.js` — (existe) pool mysql2; permanece a fonte de conexão de runtime.
- `server/auth/jwt.js` — assinatura/verificação de JWT.
- `server/auth/password.js` — hash/verify de senha (bcryptjs).
- `server/middleware/authenticate.js` — extrai/valida JWT, popula `req.auth = { userId, tenantId, role }`.
- `server/middleware/tenantScope.js` — helper central que devolve cláusula/args de filtro por tenant+role.
- `server/routes/auth.js` — `POST /api/auth/login` (+ rate limit).
- `server/routes/instances.js` — CRUD de instâncias extraído de `index.js`, agora tenant-aware.
- `server/config/cors.js` — allowlist de origens.
- `server/index.js` — (modificar) monta middlewares, rotas, remove auto-create de tabela e a checagem `X-Sentinela-Key`.
- `test/` — testes Vitest (`test/setup.js`, `test/schema.test.js`, `test/auth.test.js`, `test/tenantScope.test.js`, `test/instances.test.js`).
- `docker-compose.test.yml` — MySQL 8 efêmero para testes.
- `vitest.config.js`.
- `README.md` — (modificar/criar) documentar novo fluxo de auth e variáveis de ambiente.

**Responsabilidades:** cada arquivo em `server/` tem uma responsabilidade única (auth, escopo, uma família de rotas). Migrations são atômicas por mudança. Nada de "utils" genérico grande.

---

## Fase 0 — Tooling, harness de teste e baseline de migrations

Objetivo: infra de migrations + testes rodando, com o schema atual capturado como baseline reproduzível.

### Task 0.1: Branch de trabalho e dependências

**Files:**
- Modify: `package.json`

**Interfaces:**
- Produces: scripts npm `migrate`, `migrate:make`, `migrate:rollback`, `test`.

- [ ] **Step 1: Criar branch**

```bash
git -C /Users/felipesaman/Documents/GitHub/sentinela.nosync checkout -b feat/fase1-multitenant
```

- [ ] **Step 2: Instalar dependências**

```bash
npm --prefix /Users/felipesaman/Documents/GitHub/sentinela.nosync install knex bcryptjs jsonwebtoken express-rate-limit
npm --prefix /Users/felipesaman/Documents/GitHub/sentinela.nosync install -D vitest supertest cross-env
```

- [ ] **Step 3: Adicionar scripts em `package.json`**

Em `"scripts"`, acrescentar:

```json
"migrate": "knex --knexfile knexfile.cjs migrate:latest",
"migrate:rollback": "knex --knexfile knexfile.cjs migrate:rollback",
"migrate:make": "knex --knexfile knexfile.cjs migrate:make",
"migrate:test": "cross-env NODE_ENV=test knex --knexfile knexfile.cjs migrate:latest",
"test": "cross-env NODE_ENV=test vitest run",
"test:watch": "cross-env NODE_ENV=test vitest"
```

- [ ] **Step 4: Verificar Knex CLI disponível**

Run: `npx --prefix /Users/felipesaman/Documents/GitHub/sentinela.nosync knex --version`
Expected: imprime a versão do Knex (ex: `Knex CLI version: 3.x`).

- [ ] **Step 5: Commit**

```bash
git -C /Users/felipesaman/Documents/GitHub/sentinela.nosync add package.json package-lock.json
git -C /Users/felipesaman/Documents/GitHub/sentinela.nosync commit -m "chore: add knex, auth and test tooling deps"
```

### Task 0.2: MySQL de teste efêmero + knexfile

**Files:**
- Create: `docker-compose.test.yml`
- Create: `knexfile.cjs`

**Interfaces:**
- Consumes: `.env` (DB_* de dev) e variáveis `TEST_DB_*`.
- Produces: config Knex com ambientes `development` e `test`.

- [ ] **Step 1: Criar `docker-compose.test.yml`**

```yaml
services:
  sentinela-test-db:
    image: mysql:8.1
    container_name: sentinela_test_db
    environment:
      MYSQL_ROOT_PASSWORD: testroot
      MYSQL_DATABASE: sentinela_test
      MYSQL_USER: sentinela_test
      MYSQL_PASSWORD: sentinela_test
    ports:
      - "3307:3306"
    command: --default-authentication-plugin=caching_sha2_password
    tmpfs:
      - /var/lib/mysql
```

- [ ] **Step 2: Adicionar variáveis de teste ao `.env` local (NÃO commitar)**

Instrua o operador a acrescentar ao `.env` (o arquivo está no `.gitignore`; o assistente não consegue editá-lo por política de permissão — o operador cola):

```dotenv
# --- Test DB (container docker-compose.test.yml) ---
TEST_DB_HOST=127.0.0.1
TEST_DB_PORT=3307
TEST_DB_USER=sentinela_test
TEST_DB_PASSWORD=sentinela_test
TEST_DB_NAME=sentinela_test
# --- JWT ---
JWT_SECRET=<gerar: openssl rand -hex 32>
JWT_EXPIRES_IN=15m
# --- CORS (origens do frontend, separadas por vírgula) ---
CORS_ORIGINS=http://localhost:3000
```

- [ ] **Step 3: Criar `knexfile.cjs`**

```js
require('dotenv').config();

/** @type {import('knex').Knex.Config} */
const base = {
  client: 'mysql2',
  migrations: { directory: './migrations', tableName: 'knex_migrations' },
  pool: { min: 0, max: 10 },
};

module.exports = {
  development: {
    ...base,
    connection: {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    },
  },
  test: {
    ...base,
    connection: {
      host: process.env.TEST_DB_HOST || '127.0.0.1',
      port: Number(process.env.TEST_DB_PORT) || 3307,
      user: process.env.TEST_DB_USER || 'sentinela_test',
      password: process.env.TEST_DB_PASSWORD || 'sentinela_test',
      database: process.env.TEST_DB_NAME || 'sentinela_test',
    },
  },
};
```

Nota: `NODE_ENV` seleciona o ambiente. Os scripts `*:test` setam `NODE_ENV=test`. O `migrate` (dev) roda quando `NODE_ENV` não é `test`; garantir que Knex use o ambiente certo passando `--env`:
Ajustar script `migrate` para `knex --knexfile knexfile.cjs --env development migrate:latest` e `migrate:test` para `--env test`.

- [ ] **Step 4: Subir o DB de teste e validar conexão**

```bash
docker compose -f /Users/felipesaman/Documents/GitHub/sentinela.nosync/docker-compose.test.yml up -d
sleep 15
docker exec sentinela_test_db mysqladmin ping -uroot -ptestroot
```
Expected: `mysqld is alive`.

- [ ] **Step 5: Commit**

```bash
git -C /Users/felipesaman/Documents/GitHub/sentinela.nosync add docker-compose.test.yml knexfile.cjs
git -C /Users/felipesaman/Documents/GitHub/sentinela.nosync commit -m "chore: add ephemeral test MySQL and knexfile"
```

### Task 0.3: Vitest + helper de conexão de teste

**Files:**
- Create: `vitest.config.js`
- Create: `test/helpers/db.js`

**Interfaces:**
- Produces: `getTestPool()` → pool mysql2 conectado ao DB de teste; `resetSchema()` → dropa e recria o schema de teste (via migrations).

- [ ] **Step 1: Criar `vitest.config.js`**

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    fileParallelism: false, // testes compartilham o mesmo DB de teste
    hookTimeout: 30000,
    testTimeout: 30000,
  },
});
```

- [ ] **Step 2: Criar `test/helpers/db.js`**

```js
import mysql from 'mysql2/promise';
import knexFactory from 'knex';
import config from '../../knexfile.cjs';

export function getTestPool() {
  return mysql.createPool({
    host: process.env.TEST_DB_HOST || '127.0.0.1',
    port: Number(process.env.TEST_DB_PORT) || 3307,
    user: process.env.TEST_DB_USER || 'sentinela_test',
    password: process.env.TEST_DB_PASSWORD || 'sentinela_test',
    database: process.env.TEST_DB_NAME || 'sentinela_test',
    waitForConnections: true,
    connectionLimit: 5,
  });
}

// Recria o schema do zero rodando rollback total + migrate:latest.
export async function resetSchema() {
  const knex = knexFactory(config.test);
  try {
    await knex.migrate.rollback(undefined, true); // all
    await knex.migrate.latest();
  } finally {
    await knex.destroy();
  }
}
```

- [ ] **Step 3: Smoke test do harness**

Criar `test/harness.test.js`:

```js
import { describe, it, expect, afterAll } from 'vitest';
import { getTestPool } from './helpers/db.js';

const pool = getTestPool();
afterAll(() => pool.end());

describe('test harness', () => {
  it('conecta no DB de teste', async () => {
    const [rows] = await pool.query('SELECT DATABASE() AS db');
    expect(rows[0].db).toBe(process.env.TEST_DB_NAME || 'sentinela_test');
  });
});
```

- [ ] **Step 4: Rodar**

Run: `npm --prefix /Users/felipesaman/Documents/GitHub/sentinela.nosync test`
Expected: PASS (1 teste).

- [ ] **Step 5: Commit**

```bash
git -C /Users/felipesaman/Documents/GitHub/sentinela.nosync add vitest.config.js test/
git -C /Users/felipesaman/Documents/GitHub/sentinela.nosync commit -m "test: add vitest harness against ephemeral test DB"
```

### Task 0.4: Migration baseline (schema atual real)

Captura o schema **exatamente como está hoje no DB dev** (reverse-engineered), para que `migrate:latest` num DB vazio reproduza o estado atual antes das mudanças da Fase 1. Reversível.

**Files:**
- Create: `migrations/<ts>_baseline.cjs`
- Test: `test/schema.test.js`

**Interfaces:**
- Produces: tabelas `chats, contacts, instances, sentinela_instances, messages, mentions` com PKs de coluna única e FKs `messages_ibfk_1/2/3`, `mentions_ibfk_1`, exatamente como o `SHOW CREATE TABLE` atual.

- [ ] **Step 1: Escrever teste de schema (falha primeiro)**

`test/schema.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getTestPool, resetSchema } from './helpers/db.js';

const pool = getTestPool();
beforeAll(async () => { await resetSchema(); });
afterAll(() => pool.end());

async function columns(table) {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME, COLUMN_KEY FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [table]);
  return rows;
}

describe('baseline schema', () => {
  it('cria as 6 tabelas base', async () => {
    const [rows] = await pool.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`);
    const names = rows.map(r => r.TABLE_NAME);
    for (const t of ['chats','contacts','instances','sentinela_instances','messages','mentions']) {
      expect(names).toContain(t);
    }
  });

  it('messages tem PK id e colunas esperadas', async () => {
    const cols = (await columns('messages')).map(c => c.COLUMN_NAME);
    expect(cols).toEqual(expect.arrayContaining(
      ['id','chat_id','contact_id','text','type','from_me','from_internal','timestamp','wid']));
  });
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `npm --prefix /Users/felipesaman/Documents/GitHub/sentinela.nosync test -- test/schema.test.js`
Expected: FAIL (migration inexistente / tabelas ausentes).

- [ ] **Step 3: Gerar e escrever a migration baseline**

```bash
npm --prefix /Users/felipesaman/Documents/GitHub/sentinela.nosync run migrate:make -- baseline
```

Conteúdo do arquivo gerado em `migrations/<ts>_baseline.cjs` (usar `knex.raw` para reproduzir o DDL exato observado):

```js
exports.up = async function (knex) {
  await knex.raw(`
    CREATE TABLE chats (
      id varchar(50) NOT NULL,
      title varchar(255) DEFAULT NULL,
      is_group tinyint(1) DEFAULT NULL,
      created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

  await knex.raw(`
    CREATE TABLE contacts (
      id varchar(50) NOT NULL,
      phone varchar(20) DEFAULT NULL,
      name varchar(255) DEFAULT NULL,
      created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

  await knex.raw(`
    CREATE TABLE instances (
      wid varchar(50) NOT NULL,
      created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
      id varchar(64) DEFAULT NULL,
      name varchar(100) DEFAULT NULL,
      token varchar(128) DEFAULT NULL,
      contact_name varchar(100) DEFAULT NULL,
      phone_number varchar(50) DEFAULT NULL,
      avatar_url text,
      status varchar(50) DEFAULT 'Disconnected',
      webhook_url text,
      updated_at timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (wid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

  await knex.raw(`
    CREATE TABLE sentinela_instances (
      id varchar(64) NOT NULL,
      name varchar(100) NOT NULL,
      token varchar(128) NOT NULL,
      status varchar(50) DEFAULT 'Disconnected',
      phone_number varchar(50) DEFAULT NULL,
      contact_name varchar(100) DEFAULT NULL,
      avatar_url text,
      webhook_url text,
      created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

  await knex.raw(`
    CREATE TABLE messages (
      id varchar(50) NOT NULL,
      chat_id varchar(50) DEFAULT NULL,
      contact_id varchar(50) DEFAULT NULL,
      text text,
      type varchar(50) DEFAULT NULL,
      from_me tinyint(1) DEFAULT NULL,
      from_internal tinyint(1) DEFAULT NULL,
      timestamp timestamp NULL DEFAULT NULL,
      wid varchar(50) DEFAULT NULL,
      PRIMARY KEY (id),
      KEY wid (wid),
      KEY idx_chat_id (chat_id),
      KEY idx_contact_id (contact_id),
      KEY idx_timestamp (timestamp),
      CONSTRAINT messages_ibfk_1 FOREIGN KEY (chat_id) REFERENCES chats (id),
      CONSTRAINT messages_ibfk_2 FOREIGN KEY (contact_id) REFERENCES contacts (id),
      CONSTRAINT messages_ibfk_3 FOREIGN KEY (wid) REFERENCES instances (wid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

  await knex.raw(`
    CREATE TABLE mentions (
      id bigint unsigned NOT NULL AUTO_INCREMENT,
      message_id varchar(50) DEFAULT NULL,
      phone varchar(20) DEFAULT NULL,
      name varchar(255) DEFAULT NULL,
      PRIMARY KEY (id),
      KEY message_id (message_id),
      CONSTRAINT mentions_ibfk_1 FOREIGN KEY (message_id) REFERENCES messages (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
};

exports.down = async function (knex) {
  await knex.raw('DROP TABLE IF EXISTS mentions');
  await knex.raw('DROP TABLE IF EXISTS messages');
  await knex.raw('DROP TABLE IF EXISTS sentinela_instances');
  await knex.raw('DROP TABLE IF EXISTS instances');
  await knex.raw('DROP TABLE IF EXISTS contacts');
  await knex.raw('DROP TABLE IF EXISTS chats');
};
```

- [ ] **Step 4: Rodar teste (passa)**

Run: `npm --prefix /Users/felipesaman/Documents/GitHub/sentinela.nosync test -- test/schema.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/felipesaman/Documents/GitHub/sentinela.nosync add migrations/ test/schema.test.js
git -C /Users/felipesaman/Documents/GitHub/sentinela.nosync commit -m "feat(db): baseline migration reproducing current schema"
```

---

## Fase 1 — Schema multi-tenant + RBAC

Objetivo: novas tabelas de tenant/RBAC e conversão das tabelas de dados para PK composta + `tenant_id`. Cada migration reversível. DB vazio ⇒ ALTERs sem risco de dados.

### Estratégia de `ON DELETE` (documentar no topo de cada migration como comentário)

- `users.tenant_id → tenants.id`: **ON DELETE CASCADE** — apagar um tenant apaga seus usuários (não faz sentido usuário órfão de tenant). Superadmin tem `tenant_id NULL` (não afetado).
- `teams.tenant_id → tenants.id`: **CASCADE** — equipes pertencem ao tenant.
- `team_managers.user_id → users.id` / `team_managers.team_id → teams.id`: **CASCADE** — vínculo some com qualquer das pontas.
- `team_instances.team_id → teams.id`: **CASCADE**. `team_instances.instance_id → sentinela_instances.id`: **CASCADE** — remover a instância remove o vínculo.
- `user_instances.user_id → users.id` / `→ sentinela_instances.id`: **CASCADE**.
- `sentinela_instances.tenant_id → tenants.id`: **RESTRICT** — impedir apagar tenant com instâncias ativas sem antes tratá-las (evita perda silenciosa de dado operacional). Apagar via app exige remover instâncias primeiro.
- `instances.tenant_id → tenants.id`: **RESTRICT** — mesmo motivo; `instances` é registro histórico.
- `messages.tenant_id`, `chats`/`contacts` PK composta, FKs compostas `messages→chats/contacts`, `mentions→messages`: **RESTRICT** no update, **CASCADE** no delete do pai lógico não se aplica (dados imutáveis read-only); usar **RESTRICT** para preservar integridade histórica.

### Task 1.1: Tabela `tenants`

**Files:**
- Create: `migrations/<ts>_create_tenants.cjs`
- Test: `test/schema.test.js` (adicionar bloco)

**Interfaces:**
- Produces: `tenants(id BIGINT UNSIGNED AUTO_INCREMENT PK, name, status ENUM('active','suspended') DEFAULT 'active', created_at, updated_at)`.

- [ ] **Step 1: Teste (falha primeiro)** — adicionar a `test/schema.test.js`:

```js
describe('tenants', () => {
  it('existe com colunas esperadas', async () => {
    const [rows] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='tenants'`);
    const cols = rows.map(r => r.COLUMN_NAME);
    expect(cols).toEqual(expect.arrayContaining(['id','name','status','created_at','updated_at']));
  });
});
```

- [ ] **Step 2: Rodar (falha)** — `npm test -- test/schema.test.js` → FAIL.

- [ ] **Step 3: Migration**

`migrations/<ts>_create_tenants.cjs`:

```js
exports.up = (knex) => knex.raw(`
  CREATE TABLE tenants (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    name VARCHAR(150) NOT NULL,
    status ENUM('active','suspended') NOT NULL DEFAULT 'active',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_tenants_name (name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

exports.down = (knex) => knex.raw('DROP TABLE IF EXISTS tenants');
```

- [ ] **Step 4: Rodar (passa)** — `npm test -- test/schema.test.js` → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(db): tenants table"`.

### Task 1.2: Tabela `users` (RBAC)

**Files:**
- Create: `migrations/<ts>_create_users.cjs`
- Test: `test/schema.test.js`

**Interfaces:**
- Produces: `users(id BIGINT UNSIGNED PK, tenant_id BIGINT UNSIGNED NULL FK→tenants, name, email UNIQUE, password_hash, role ENUM('superadmin','admin','gestor','usuario'), status ENUM('active','disabled'), created_at, updated_at)`.
- Regra: `role='superadmin'` ⇒ `tenant_id NULL`; demais roles ⇒ `tenant_id NOT NULL` (validado na app, não por CHECK para compat MySQL).

- [ ] **Step 1: Teste (falha)** — adicionar bloco verificando colunas `id,tenant_id,name,email,password_hash,role,status` e o índice único de `email`.

```js
describe('users', () => {
  it('tem colunas e email único', async () => {
    const [cols] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users'`);
    expect(cols.map(c=>c.COLUMN_NAME)).toEqual(expect.arrayContaining(
      ['id','tenant_id','name','email','password_hash','role','status']));
    const [idx] = await pool.query(
      `SELECT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='email' AND NON_UNIQUE=0`);
    expect(idx.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Rodar (falha)**.

- [ ] **Step 3: Migration**

```js
exports.up = (knex) => knex.raw(`
  CREATE TABLE users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id BIGINT UNSIGNED NULL,
    name VARCHAR(150) NOT NULL,
    email VARCHAR(190) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('superadmin','admin','gestor','usuario') NOT NULL,
    status ENUM('active','disabled') NOT NULL DEFAULT 'active',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_users_email (email),
    KEY idx_users_tenant (tenant_id),
    CONSTRAINT fk_users_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

exports.down = (knex) => knex.raw('DROP TABLE IF EXISTS users');
```

- [ ] **Step 4: Rodar (passa)**.
- [ ] **Step 5: Commit** — `git commit -m "feat(db): users table with RBAC role enum"`.

### Task 1.3: `teams`, `team_managers`, `team_instances`, `user_instances`

Nota de design: a spec lista `teams`, `team_managers`, `team_instances`. Adiciona-se **`user_instances`** (N:N `users`[role=usuario] ↔ `sentinela_instances`) — necessário para cumprir o requisito "Usuário vê apenas os próprios números", que não é coberto pelas outras junções.

**Files:**
- Create: `migrations/<ts>_create_teams_and_links.cjs`
- Test: `test/schema.test.js`

**Interfaces:**
- Produces:
  - `teams(id BIGINT UNSIGNED PK, tenant_id FK→tenants CASCADE, name, created_at, updated_at, UNIQUE(tenant_id,name))`
  - `team_managers(team_id FK→teams CASCADE, user_id FK→users CASCADE, PK(team_id,user_id))`
  - `team_instances(team_id FK→teams CASCADE, instance_id VARCHAR(64) FK→sentinela_instances.id CASCADE, PK(team_id,instance_id))`
  - `user_instances(user_id FK→users CASCADE, instance_id VARCHAR(64) FK→sentinela_instances.id CASCADE, PK(user_id,instance_id))`

- [ ] **Step 1: Teste (falha)** — verificar existência das 4 tabelas e suas PKs compostas:

```js
describe('teams e junções', () => {
  it('cria teams, team_managers, team_instances, user_instances', async () => {
    const [rows] = await pool.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()`);
    const names = rows.map(r=>r.TABLE_NAME);
    for (const t of ['teams','team_managers','team_instances','user_instances']) {
      expect(names).toContain(t);
    }
  });
});
```

- [ ] **Step 2: Rodar (falha)**.

- [ ] **Step 3: Migration**

```js
exports.up = async (knex) => {
  await knex.raw(`
    CREATE TABLE teams (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      tenant_id BIGINT UNSIGNED NOT NULL,
      name VARCHAR(150) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_teams_tenant_name (tenant_id, name),
      CONSTRAINT fk_teams_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

  await knex.raw(`
    CREATE TABLE team_managers (
      team_id BIGINT UNSIGNED NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (team_id, user_id),
      KEY idx_tm_user (user_id),
      CONSTRAINT fk_tm_team FOREIGN KEY (team_id) REFERENCES teams (id) ON DELETE CASCADE,
      CONSTRAINT fk_tm_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

  await knex.raw(`
    CREATE TABLE team_instances (
      team_id BIGINT UNSIGNED NOT NULL,
      instance_id VARCHAR(64) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (team_id, instance_id),
      KEY idx_ti_instance (instance_id),
      CONSTRAINT fk_ti_team FOREIGN KEY (team_id) REFERENCES teams (id) ON DELETE CASCADE,
      CONSTRAINT fk_ti_instance FOREIGN KEY (instance_id) REFERENCES sentinela_instances (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);

  await knex.raw(`
    CREATE TABLE user_instances (
      user_id BIGINT UNSIGNED NOT NULL,
      instance_id VARCHAR(64) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, instance_id),
      KEY idx_ui_instance (instance_id),
      CONSTRAINT fk_ui_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
      CONSTRAINT fk_ui_instance FOREIGN KEY (instance_id) REFERENCES sentinela_instances (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
};

exports.down = async (knex) => {
  await knex.raw('DROP TABLE IF EXISTS user_instances');
  await knex.raw('DROP TABLE IF EXISTS team_instances');
  await knex.raw('DROP TABLE IF EXISTS team_managers');
  await knex.raw('DROP TABLE IF EXISTS teams');
};
```

- [ ] **Step 4: Rodar (passa)**.
- [ ] **Step 5: Commit** — `git commit -m "feat(db): teams and RBAC junction tables"`.

### Task 1.4: `tenant_id` em `instances` e `sentinela_instances` (FK simples)

**Files:**
- Create: `migrations/<ts>_add_tenant_to_instances.cjs`
- Test: `test/schema.test.js`

**Interfaces:**
- Produces: coluna `tenant_id BIGINT UNSIGNED NULL` + FK RESTRICT em ambas as tabelas + índice.
- Nota: `NULL` permitido temporariamente porque pode haver instâncias legadas sem tenant; a app exige tenant ao criar. (DB atual vazio ⇒ sem legado.)

- [ ] **Step 1: Teste (falha)** — verificar coluna `tenant_id` em `instances` e `sentinela_instances`.

- [ ] **Step 2: Rodar (falha)**.

- [ ] **Step 3: Migration**

```js
exports.up = async (knex) => {
  await knex.raw(`ALTER TABLE sentinela_instances
    ADD COLUMN tenant_id BIGINT UNSIGNED NULL AFTER id,
    ADD KEY idx_si_tenant (tenant_id),
    ADD CONSTRAINT fk_si_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT`);
  await knex.raw(`ALTER TABLE instances
    ADD COLUMN tenant_id BIGINT UNSIGNED NULL AFTER wid,
    ADD KEY idx_inst_tenant (tenant_id),
    ADD CONSTRAINT fk_inst_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT`);
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE instances DROP FOREIGN KEY fk_inst_tenant, DROP KEY idx_inst_tenant, DROP COLUMN tenant_id');
  await knex.raw('ALTER TABLE sentinela_instances DROP FOREIGN KEY fk_si_tenant, DROP KEY idx_si_tenant, DROP COLUMN tenant_id');
};
```

- [ ] **Step 4: Rodar (passa)**.
- [ ] **Step 5: Commit** — `git commit -m "feat(db): tenant_id FK on instances tables"`.

### Task 1.5: Converter `chats`/`contacts`/`messages`/`mentions` para tenant-scoped (PK composta + FKs compostas)

Migration crítica. Ordem obrigatória: **1)** dropar FKs que apontam para `chats`/`contacts`/`messages`; **2)** adicionar `tenant_id`; **3)** trocar PKs para compostas; **4)** recriar FKs compostas. DB vazio ⇒ sem violação de dados.

**Files:**
- Create: `migrations/<ts>_tenant_scope_data_tables.cjs`
- Test: `test/schema.test.js`

**Interfaces:**
- Produces:
  - `chats` PK `(tenant_id, id)`; `contacts` PK `(tenant_id, id)`; `messages` PK `(tenant_id, id)`.
  - `messages.tenant_id`, `mentions.tenant_id` NOT NULL.
  - FK `fk_msg_chat (tenant_id, chat_id) → chats(tenant_id, id)`.
  - FK `fk_msg_contact (tenant_id, contact_id) → contacts(tenant_id, id)`.
  - FK `fk_msg_instance (wid) → instances(wid)` (recriada; simples, wid é único por tenant).
  - FK `fk_mentions_msg (tenant_id, message_id) → messages(tenant_id, id)`.

- [ ] **Step 1: Teste (falha primeiro)** — verificar PK composta e FKs compostas:

```js
describe('tenant-scoped data tables', () => {
  async function pk(table) {
    const [rows] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME='PRIMARY'
       ORDER BY SEQ_IN_INDEX`, [table]);
    return rows.map(r => r.COLUMN_NAME);
  }
  it('chats/contacts/messages têm PK (tenant_id, id)', async () => {
    expect(await pk('chats')).toEqual(['tenant_id','id']);
    expect(await pk('contacts')).toEqual(['tenant_id','id']);
    expect(await pk('messages')).toEqual(['tenant_id','id']);
  });
  it('messages e mentions têm tenant_id', async () => {
    const [c] = await pool.query(
      `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA=DATABASE() AND COLUMN_NAME='tenant_id'
         AND TABLE_NAME IN ('messages','mentions','chats','contacts')`);
    const set = new Set(c.map(r=>r.TABLE_NAME));
    for (const t of ['messages','mentions','chats','contacts']) expect(set.has(t)).toBe(true);
  });
  it('recria FK composta messages->chats', async () => {
    const [fk] = await pool.query(
      `SELECT CONSTRAINT_NAME, COUNT(*) n FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='messages'
         AND REFERENCED_TABLE_NAME='chats' GROUP BY CONSTRAINT_NAME`);
    expect(fk.some(r => r.n === 2)).toBe(true); // (tenant_id, chat_id)
  });
});
```

- [ ] **Step 2: Rodar (falha)**.

- [ ] **Step 3: Migration**

```js
exports.up = async (knex) => {
  // 1) Dropar FKs dependentes
  await knex.raw('ALTER TABLE mentions DROP FOREIGN KEY mentions_ibfk_1');
  await knex.raw('ALTER TABLE messages DROP FOREIGN KEY messages_ibfk_1'); // chat_id->chats
  await knex.raw('ALTER TABLE messages DROP FOREIGN KEY messages_ibfk_2'); // contact_id->contacts
  await knex.raw('ALTER TABLE messages DROP FOREIGN KEY messages_ibfk_3'); // wid->instances

  // 2) tenant_id nas tabelas de dados
  await knex.raw('ALTER TABLE chats ADD COLUMN tenant_id BIGINT UNSIGNED NOT NULL AFTER id');
  await knex.raw('ALTER TABLE contacts ADD COLUMN tenant_id BIGINT UNSIGNED NOT NULL AFTER id');
  await knex.raw('ALTER TABLE messages ADD COLUMN tenant_id BIGINT UNSIGNED NOT NULL AFTER id');
  await knex.raw('ALTER TABLE mentions ADD COLUMN tenant_id BIGINT UNSIGNED NOT NULL AFTER id');

  // 3) PKs compostas (dropar PK antiga e criar composta)
  await knex.raw('ALTER TABLE chats DROP PRIMARY KEY, ADD PRIMARY KEY (tenant_id, id)');
  await knex.raw('ALTER TABLE contacts DROP PRIMARY KEY, ADD PRIMARY KEY (tenant_id, id)');
  await knex.raw('ALTER TABLE messages DROP PRIMARY KEY, ADD PRIMARY KEY (tenant_id, id)');

  // Índices auxiliares para as FKs compostas (a coluna referenciante precisa de índice à esquerda)
  await knex.raw('ALTER TABLE messages ADD KEY idx_msg_tenant_chat (tenant_id, chat_id)');
  await knex.raw('ALTER TABLE messages ADD KEY idx_msg_tenant_contact (tenant_id, contact_id)');
  await knex.raw('ALTER TABLE mentions ADD KEY idx_mentions_tenant_msg (tenant_id, message_id)');

  // 4) Recriar FKs compostas + a de instances (wid)
  await knex.raw(`ALTER TABLE messages
    ADD CONSTRAINT fk_msg_chat FOREIGN KEY (tenant_id, chat_id) REFERENCES chats (tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT fk_msg_contact FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT fk_msg_instance FOREIGN KEY (wid) REFERENCES instances (wid) ON DELETE RESTRICT ON UPDATE RESTRICT`);

  await knex.raw(`ALTER TABLE mentions
    ADD CONSTRAINT fk_mentions_msg FOREIGN KEY (tenant_id, message_id) REFERENCES messages (tenant_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT`);
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE mentions DROP FOREIGN KEY fk_mentions_msg');
  await knex.raw('ALTER TABLE messages DROP FOREIGN KEY fk_msg_chat, DROP FOREIGN KEY fk_msg_contact, DROP FOREIGN KEY fk_msg_instance');

  await knex.raw('ALTER TABLE mentions DROP KEY idx_mentions_tenant_msg');
  await knex.raw('ALTER TABLE messages DROP KEY idx_msg_tenant_chat, DROP KEY idx_msg_tenant_contact');

  await knex.raw('ALTER TABLE messages DROP PRIMARY KEY, ADD PRIMARY KEY (id)');
  await knex.raw('ALTER TABLE contacts DROP PRIMARY KEY, ADD PRIMARY KEY (id)');
  await knex.raw('ALTER TABLE chats DROP PRIMARY KEY, ADD PRIMARY KEY (id)');

  await knex.raw('ALTER TABLE mentions DROP COLUMN tenant_id');
  await knex.raw('ALTER TABLE messages DROP COLUMN tenant_id');
  await knex.raw('ALTER TABLE contacts DROP COLUMN tenant_id');
  await knex.raw('ALTER TABLE chats DROP COLUMN tenant_id');

  // Recriar FKs originais (estado baseline)
  await knex.raw(`ALTER TABLE messages
    ADD CONSTRAINT messages_ibfk_1 FOREIGN KEY (chat_id) REFERENCES chats (id),
    ADD CONSTRAINT messages_ibfk_2 FOREIGN KEY (contact_id) REFERENCES contacts (id),
    ADD CONSTRAINT messages_ibfk_3 FOREIGN KEY (wid) REFERENCES instances (wid)`);
  await knex.raw(`ALTER TABLE mentions
    ADD CONSTRAINT mentions_ibfk_1 FOREIGN KEY (message_id) REFERENCES messages (id)`);
};
```

- [ ] **Step 4: Rodar (passa)** e validar rollback:

```bash
npm --prefix /Users/felipesaman/Documents/GitHub/sentinela.nosync run test -- test/schema.test.js
npm --prefix /Users/felipesaman/Documents/GitHub/sentinela.nosync run migrate:test -- --env test
cross-env NODE_ENV=test npx --prefix /Users/felipesaman/Documents/GitHub/sentinela.nosync knex --knexfile knexfile.cjs --env test migrate:rollback
```
Expected: teste PASS; rollback sem erro.

- [ ] **Step 5: Commit** — `git commit -m "feat(db): tenant-scoped composite PKs and FKs on data tables"`.

### Task 1.6: Índices de performance faltantes

Só faltam `contacts.phone` e `chats.title` (os de `messages` já existem no baseline). `contacts.phone` deve incluir `tenant_id` à esquerda para casar com o padrão de filtro.

**Files:**
- Create: `migrations/<ts>_perf_indexes.cjs`
- Test: `test/schema.test.js`

**Interfaces:**
- Produces: `idx_contacts_tenant_phone (tenant_id, phone)`, `idx_chats_tenant_title (tenant_id, title)`.

- [ ] **Step 1: Teste (falha)** — verificar existência dos dois índices via `information_schema.STATISTICS`.

- [ ] **Step 2: Rodar (falha)**.

- [ ] **Step 3: Migration**

```js
exports.up = async (knex) => {
  await knex.raw('ALTER TABLE contacts ADD KEY idx_contacts_tenant_phone (tenant_id, phone)');
  await knex.raw('ALTER TABLE chats ADD KEY idx_chats_tenant_title (tenant_id, title)');
};
exports.down = async (knex) => {
  await knex.raw('ALTER TABLE chats DROP KEY idx_chats_tenant_title');
  await knex.raw('ALTER TABLE contacts DROP KEY idx_contacts_tenant_phone');
};
```

- [ ] **Step 4: Rodar (passa)**.
- [ ] **Step 5: Commit** — `git commit -m "perf(db): add tenant-scoped indexes on contacts.phone and chats.title"`.

---

## Fase 2 — Autenticação JWT + escopo de tenant central

### Task 2.1: Hash de senha (`server/auth/password.js`)

**Files:**
- Create: `server/auth/password.js`
- Test: `test/auth.test.js`

**Interfaces:**
- Produces: `hashPassword(plain): Promise<string>`, `verifyPassword(plain, hash): Promise<boolean>`.

- [ ] **Step 1: Teste (falha)**

`test/auth.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../server/auth/password.js';

describe('password', () => {
  it('faz hash e verifica', async () => {
    const h = await hashPassword('s3nha-forte');
    expect(h).not.toBe('s3nha-forte');
    expect(await verifyPassword('s3nha-forte', h)).toBe(true);
    expect(await verifyPassword('errada', h)).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar (falha)** — módulo inexistente.

- [ ] **Step 3: Implementar**

`server/auth/password.js`:

```js
import bcrypt from 'bcryptjs';

const ROUNDS = 12;

export const hashPassword = (plain) => bcrypt.hash(plain, ROUNDS);
export const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);
```

- [ ] **Step 4: Rodar (passa)**.
- [ ] **Step 5: Commit** — `git commit -m "feat(auth): bcrypt password hashing"`.

### Task 2.2: JWT (`server/auth/jwt.js`)

**Files:**
- Create: `server/auth/jwt.js`
- Test: `test/auth.test.js`

**Interfaces:**
- Produces: `signToken({ userId, tenantId, role }): string`, `verifyToken(token): { userId, tenantId, role, iat, exp }` (lança em token inválido/expirado).

- [ ] **Step 1: Teste (falha)** — adicionar:

```js
import { signToken, verifyToken } from '../server/auth/jwt.js';

describe('jwt', () => {
  it('assina e verifica payload', () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    const t = signToken({ userId: 1, tenantId: 5, role: 'admin' });
    const p = verifyToken(t);
    expect(p.userId).toBe(1);
    expect(p.tenantId).toBe(5);
    expect(p.role).toBe('admin');
  });
  it('rejeita token adulterado', () => {
    expect(() => verifyToken('lixo.invalido.token')).toThrow();
  });
});
```

- [ ] **Step 2: Rodar (falha)**.

- [ ] **Step 3: Implementar**

`server/auth/jwt.js`:

```js
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
```

- [ ] **Step 4: Rodar (passa)**.
- [ ] **Step 5: Commit** — `git commit -m "feat(auth): JWT sign/verify"`.

### Task 2.3: Middleware `authenticate`

**Files:**
- Create: `server/middleware/authenticate.js`
- Test: `test/auth.test.js`

**Interfaces:**
- Consumes: `verifyToken`.
- Produces: middleware Express que lê `Authorization: Bearer <jwt>`, popula `req.auth = { userId, tenantId, role }`, responde `401` se ausente/inválido.

- [ ] **Step 1: Teste (falha)** — testar via função pura chamando o middleware com `req/res/next` mockados (Bearer válido → `next()` e `req.auth` populado; sem header → 401).

```js
import { authenticate } from '../server/middleware/authenticate.js';
import { signToken } from '../server/auth/jwt.js';

function mockRes() {
  return { statusCode: 0, body: null,
    status(c){ this.statusCode=c; return this; },
    json(b){ this.body=b; return this; } };
}

describe('authenticate', () => {
  it('popula req.auth com Bearer válido', () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    const token = signToken({ userId: 7, tenantId: 2, role: 'gestor' });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes(); let called = false;
    authenticate(req, res, () => { called = true; });
    expect(called).toBe(true);
    expect(req.auth).toEqual(expect.objectContaining({ userId: 7, tenantId: 2, role: 'gestor' }));
  });
  it('401 sem header', () => {
    const req = { headers: {} }; const res = mockRes();
    authenticate(req, res, () => {});
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Rodar (falha)**.

- [ ] **Step 3: Implementar**

`server/middleware/authenticate.js`:

```js
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
```

- [ ] **Step 4: Rodar (passa)**.
- [ ] **Step 5: Commit** — `git commit -m "feat(auth): authenticate middleware populating req.auth"`.

### Task 2.4: Helper central de escopo de tenant (`server/middleware/tenantScope.js`)

Coração da segurança: dado `req.auth`, devolve a cláusula SQL + args para restringir qualquer query por tenant e (para gestor/usuario) pelo conjunto de instâncias visíveis.

**Files:**
- Create: `server/middleware/tenantScope.js`
- Test: `test/tenantScope.test.js`

**Interfaces:**
- Produces:
  - `tenantFilter(auth, alias='') → { sql: string, params: any[] }` — devolve `''` para superadmin (sem restrição), ou `<alias>tenant_id = ?` para os demais.
  - `visibleInstanceIds(pool, auth) → Promise<string[] | 'ALL'>` — resolve as instâncias visíveis: superadmin/admin → `'ALL'` (todas do tenant, tratado por `tenantFilter`); gestor → instâncias de suas equipes; usuario → suas instâncias de `user_instances`.
  - `assertTenantMatch(auth, resourceTenantId)` — lança `403` se `auth` não-superadmin tentar acessar outro tenant.

- [ ] **Step 1: Teste (falha)**

`test/tenantScope.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getTestPool, resetSchema } from './helpers/db.js';
import { tenantFilter, visibleInstanceIds } from '../server/middleware/tenantScope.js';

const pool = getTestPool();
beforeAll(async () => {
  await resetSchema();
  // Seed: 2 tenants, instâncias, equipes, vínculos
  await pool.query("INSERT INTO tenants (id, name) VALUES (1,'T1'),(2,'T2')");
  await pool.query(`INSERT INTO sentinela_instances (id, tenant_id, name, token) VALUES
    ('i1',1,'A','t1'),('i2',1,'B','t2'),('i3',2,'C','t3')`);
  await pool.query(`INSERT INTO users (id, tenant_id, name, email, password_hash, role) VALUES
    (10,1,'Gestor1','g1@t1','x','gestor'),(11,1,'User1','u1@t1','x','usuario')`);
  await pool.query("INSERT INTO teams (id, tenant_id, name) VALUES (100,1,'Eq1')");
  await pool.query("INSERT INTO team_managers (team_id, user_id) VALUES (100,10)");
  await pool.query("INSERT INTO team_instances (team_id, instance_id) VALUES (100,'i1')");
  await pool.query("INSERT INTO user_instances (user_id, instance_id) VALUES (11,'i2')");
});
afterAll(() => pool.end());

describe('tenantFilter', () => {
  it('superadmin sem restrição', () => {
    expect(tenantFilter({ role: 'superadmin', tenantId: null }).sql).toBe('');
  });
  it('admin restringe por tenant', () => {
    const f = tenantFilter({ role: 'admin', tenantId: 1 }, 'm.');
    expect(f.sql).toBe('m.tenant_id = ?');
    expect(f.params).toEqual([1]);
  });
});

describe('visibleInstanceIds', () => {
  it('admin vê ALL', async () => {
    expect(await visibleInstanceIds(pool, { role: 'admin', tenantId: 1 })).toBe('ALL');
  });
  it('gestor vê instâncias das suas equipes', async () => {
    const ids = await visibleInstanceIds(pool, { role: 'gestor', tenantId: 1, userId: 10 });
    expect(ids).toEqual(['i1']);
  });
  it('usuario vê só as próprias instâncias', async () => {
    const ids = await visibleInstanceIds(pool, { role: 'usuario', tenantId: 1, userId: 11 });
    expect(ids).toEqual(['i2']);
  });
});
```

- [ ] **Step 2: Rodar (falha)**.

- [ ] **Step 3: Implementar**

`server/middleware/tenantScope.js`:

```js
// Restrição por tenant. Superadmin => sem cláusula.
export function tenantFilter(auth, alias = '') {
  if (auth.role === 'superadmin') return { sql: '', params: [] };
  return { sql: `${alias}tenant_id = ?`, params: [auth.tenantId] };
}

// Conjunto de instâncias visíveis para o usuário.
// admin/superadmin => 'ALL' (o filtro de tenant já basta).
export async function visibleInstanceIds(pool, auth) {
  if (auth.role === 'superadmin' || auth.role === 'admin') return 'ALL';

  if (auth.role === 'gestor') {
    const [rows] = await pool.query(
      `SELECT DISTINCT ti.instance_id
       FROM team_managers tm
       JOIN team_instances ti ON ti.team_id = tm.team_id
       JOIN teams t ON t.id = tm.team_id
       WHERE tm.user_id = ? AND t.tenant_id = ?`,
      [auth.userId, auth.tenantId]);
    return rows.map(r => r.instance_id);
  }

  // usuario
  const [rows] = await pool.query(
    `SELECT ui.instance_id
     FROM user_instances ui
     JOIN sentinela_instances si ON si.id = ui.instance_id
     WHERE ui.user_id = ? AND si.tenant_id = ?`,
    [auth.userId, auth.tenantId]);
  return rows.map(r => r.instance_id);
}

export function assertTenantMatch(auth, resourceTenantId) {
  if (auth.role === 'superadmin') return;
  if (Number(auth.tenantId) !== Number(resourceTenantId)) {
    const err = new Error('Acesso negado a outro tenant');
    err.statusCode = 403;
    throw err;
  }
}
```

- [ ] **Step 4: Rodar (passa)**.
- [ ] **Step 5: Commit** — `git commit -m "feat(auth): central tenant-scope helper (filter + visible instances)"`.

### Task 2.5: Rota de login com rate limit (`server/routes/auth.js`)

**Files:**
- Create: `server/routes/auth.js`
- Test: `test/auth.test.js` (bloco de integração via Supertest)

**Interfaces:**
- Consumes: `pool` (mysql2), `verifyPassword`, `signToken`.
- Produces: router com `POST /login` → `{ token, user: { id, name, role, tenantId } }`; `401` em credencial inválida; rate-limit 10 req / 15 min por IP.
- Exporta factory `createAuthRouter(pool)` para injetar o pool (facilita teste).

- [ ] **Step 1: Teste (falha)**

Adicionar em `test/auth.test.js`:

```js
import express from 'express';
import request from 'supertest';
import { getTestPool, resetSchema } from './helpers/db.js';
import { hashPassword } from '../server/auth/password.js';
import { createAuthRouter } from '../server/routes/auth.js';

describe('POST /api/auth/login', () => {
  let app, pool;
  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    await resetSchema();
    pool = getTestPool();
    await pool.query("INSERT INTO tenants (id, name) VALUES (1,'T1')");
    const hash = await hashPassword('senha123');
    await pool.query(
      "INSERT INTO users (tenant_id, name, email, password_hash, role) VALUES (1,'Admin','a@t1',?, 'admin')",
      [hash]);
    app = express();
    app.use(express.json());
    app.use('/api/auth', createAuthRouter(pool));
  });
  afterAll(() => pool.end());

  it('loga com credencial válida', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'a@t1', password: 'senha123' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.role).toBe('admin');
  });
  it('401 com senha errada', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'a@t1', password: 'errada' });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Rodar (falha)**.

- [ ] **Step 3: Implementar**

`server/routes/auth.js`:

```js
import express from 'express';
import rateLimit from 'express-rate-limit';
import { verifyPassword } from '../auth/password.js';
import { signToken } from '../auth/jwt.js';

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de login. Tente novamente mais tarde.' },
});

export function createAuthRouter(pool) {
  const router = express.Router();

  router.post('/login', loginLimiter, async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email e password obrigatórios' });
    try {
      const [rows] = await pool.query(
        "SELECT id, tenant_id, name, password_hash, role, status FROM users WHERE email = ? LIMIT 1",
        [email]);
      const user = rows[0];
      // Resposta uniforme para não vazar existência do email
      if (!user || user.status !== 'active' || !(await verifyPassword(password, user.password_hash))) {
        return res.status(401).json({ error: 'Credenciais inválidas' });
      }
      const token = signToken({ userId: user.id, tenantId: user.tenant_id, role: user.role });
      return res.json({ token, user: { id: user.id, name: user.name, role: user.role, tenantId: user.tenant_id } });
    } catch (e) {
      console.error('login error:', e);
      return res.status(500).json({ error: 'Erro interno' });
    }
  });

  return router;
}
```

- [ ] **Step 4: Rodar (passa)**.
- [ ] **Step 5: Commit** — `git commit -m "feat(auth): login route with rate limiting"`.

---

## Fase 3 — Rotas tenant-aware + CORS

### Task 3.1: CORS por allowlist (`server/config/cors.js`)

**Files:**
- Create: `server/config/cors.js`
- Test: `test/cors.test.js`

**Interfaces:**
- Produces: `corsMiddleware` configurado a partir de `CORS_ORIGINS` (CSV). Bloqueia origem não listada.

- [ ] **Step 1: Teste (falha)**

`test/cors.test.js`:

```js
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { corsMiddleware } from '../server/config/cors.js';

function app() {
  const a = express();
  a.use(corsMiddleware);
  a.get('/x', (_req, res) => res.json({ ok: true }));
  return a;
}

describe('cors allowlist', () => {
  it('permite origem listada', async () => {
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    const res = await request(app()).get('/x').set('Origin', 'http://localhost:3000');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });
  it('não ecoa origem não listada', async () => {
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    const res = await request(app()).get('/x').set('Origin', 'https://evil.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
```

- [ ] **Step 2: Rodar (falha)**.

- [ ] **Step 3: Implementar**

`server/config/cors.js`:

```js
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
```

- [ ] **Step 4: Rodar (passa)**.
- [ ] **Step 5: Commit** — `git commit -m "feat(security): CORS allowlist middleware"`.

### Task 3.2: Extrair CRUD de instâncias para router tenant-aware (`server/routes/instances.js`)

Reescreve as rotas hoje inline em `index.js` para: exigir `authenticate`, filtrar por `tenant_id` (via `tenantFilter`) e, para gestor/usuario, restringir ao conjunto de `visibleInstanceIds`. `formatInstance` preservado.

**Files:**
- Create: `server/routes/instances.js`
- Test: `test/instances.test.js`

**Interfaces:**
- Consumes: `pool`, `authenticate`, `tenantFilter`, `visibleInstanceIds`, `assertTenantMatch`.
- Produces: `createInstancesRouter(pool)` com `GET /`, `POST /`, `PUT /:id`, `DELETE /:id`, todas tenant-scoped. `POST` grava `tenant_id = req.auth.tenantId` (superadmin deve mandar `tenantId` no body).

- [ ] **Step 1: Teste (falha)** — cobrir isolamento (admin do tenant 1 não vê instância do tenant 2; usuario só vê a própria):

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { getTestPool, resetSchema } from './helpers/db.js';
import { signToken } from '../server/auth/jwt.js';
import { authenticate } from '../server/middleware/authenticate.js';
import { createInstancesRouter } from '../server/routes/instances.js';

function makeApp(pool) {
  const a = express();
  a.use(express.json());
  a.use('/api/instances', authenticate, createInstancesRouter(pool));
  return a;
}
function bearer(p) { return `Bearer ${signToken(p)}`; }

describe('GET /api/instances (isolamento)', () => {
  let app, pool;
  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    await resetSchema();
    pool = getTestPool();
    await pool.query("INSERT INTO tenants (id,name) VALUES (1,'T1'),(2,'T2')");
    await pool.query(`INSERT INTO sentinela_instances (id,tenant_id,name,token) VALUES
      ('i1',1,'A','t1'),('i2',1,'B','t2'),('i3',2,'C','t3')`);
    await pool.query(`INSERT INTO users (id,tenant_id,name,email,password_hash,role) VALUES
      (11,1,'U','u@t1','x','usuario')`);
    await pool.query("INSERT INTO user_instances (user_id,instance_id) VALUES (11,'i2')");
    app = makeApp(pool);
  });
  afterAll(() => pool.end());

  it('admin do tenant 1 vê só i1,i2', async () => {
    const res = await request(app).get('/api/instances')
      .set('Authorization', bearer({ userId: 1, tenantId: 1, role: 'admin' }));
    expect(res.status).toBe(200);
    expect(res.body.map(i => i.id).sort()).toEqual(['i1','i2']);
  });
  it('usuario 11 vê só i2', async () => {
    const res = await request(app).get('/api/instances')
      .set('Authorization', bearer({ userId: 11, tenantId: 1, role: 'usuario' }));
    expect(res.body.map(i => i.id)).toEqual(['i2']);
  });
  it('sem token → 401', async () => {
    const res = await request(app).get('/api/instances');
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Rodar (falha)**.

- [ ] **Step 3: Implementar**

`server/routes/instances.js`:

```js
import express from 'express';
import { tenantFilter, visibleInstanceIds, assertTenantMatch } from '../middleware/tenantScope.js';

const formatInstance = (row) => ({
  id: row.id,
  tenantId: row.tenant_id,
  name: row.name,
  token: row.token,
  status: row.status,
  phoneNumber: row.phone_number || '',
  contactName: row.contact_name || '',
  avatarUrl: row.avatar_url || '',
  webhookUrl: row.webhook_url || '',
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export function createInstancesRouter(pool) {
  const router = express.Router();

  // GET all (tenant + role scoped)
  router.get('/', async (req, res) => {
    try {
      const { sql: tSql, params } = tenantFilter(req.auth);
      const visible = await visibleInstanceIds(pool, req.auth);

      const where = [];
      const args = [];
      if (tSql) { where.push(tSql); args.push(...params); }
      if (visible !== 'ALL') {
        if (visible.length === 0) return res.json([]);
        where.push(`id IN (${visible.map(() => '?').join(',')})`);
        args.push(...visible);
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const [rows] = await pool.query(
        `SELECT * FROM sentinela_instances ${clause} ORDER BY created_at DESC`, args);
      res.json(rows.map(formatInstance));
    } catch (e) {
      console.error('list instances:', e);
      res.status(e.statusCode || 500).json({ error: 'Falha ao listar instâncias' });
    }
  });

  // POST (admin/superadmin só)
  router.post('/', async (req, res) => {
    if (!['admin', 'superadmin'].includes(req.auth.role)) {
      return res.status(403).json({ error: 'Sem permissão para criar instância' });
    }
    const { id, name, token, status, phoneNumber, contactName, avatarUrl, webhookUrl } = req.body || {};
    const tenantId = req.auth.role === 'superadmin' ? req.body.tenantId : req.auth.tenantId;
    if (!id || !name || !token || !tenantId) {
      return res.status(400).json({ error: 'id, name, token e tenantId são obrigatórios' });
    }
    try {
      await pool.query(
        `INSERT INTO sentinela_instances
         (id, tenant_id, name, token, status, phone_number, contact_name, avatar_url, webhook_url)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [id, tenantId, name, token, status || 'Disconnected',
         phoneNumber || null, contactName || null, avatarUrl || null, webhookUrl || null]);
      const [rows] = await pool.query('SELECT * FROM sentinela_instances WHERE id = ?', [id]);
      res.status(201).json(formatInstance(rows[0]));
    } catch (e) {
      console.error('create instance:', e);
      res.status(500).json({ error: 'Falha ao criar instância' });
    }
  });

  // PUT (dentro do tenant; valida propriedade)
  router.put('/:id', async (req, res) => {
    const { id } = req.params;
    try {
      const [owned] = await pool.query('SELECT tenant_id FROM sentinela_instances WHERE id = ?', [id]);
      if (owned.length === 0) return res.status(404).json({ error: 'Instância não encontrada' });
      assertTenantMatch(req.auth, owned[0].tenant_id);

      const map = {
        name: 'name', token: 'token', status: 'status',
        phoneNumber: 'phone_number', contactName: 'contact_name',
        avatarUrl: 'avatar_url', webhookUrl: 'webhook_url',
      };
      const updates = [], values = [];
      for (const [k, col] of Object.entries(map)) {
        if (req.body[k] !== undefined) { updates.push(`${col} = ?`); values.push(req.body[k]); }
      }
      if (updates.length === 0) return res.status(400).json({ error: 'Nada para atualizar' });
      values.push(id);
      await pool.query(`UPDATE sentinela_instances SET ${updates.join(', ')} WHERE id = ?`, values);
      const [rows] = await pool.query('SELECT * FROM sentinela_instances WHERE id = ?', [id]);
      res.json(formatInstance(rows[0]));
    } catch (e) {
      if (e.statusCode === 403) return res.status(403).json({ error: e.message });
      console.error('update instance:', e);
      res.status(500).json({ error: 'Falha ao atualizar instância' });
    }
  });

  // DELETE (admin/superadmin, dentro do tenant)
  router.delete('/:id', async (req, res) => {
    if (!['admin', 'superadmin'].includes(req.auth.role)) {
      return res.status(403).json({ error: 'Sem permissão' });
    }
    const { id } = req.params;
    try {
      const [owned] = await pool.query('SELECT tenant_id FROM sentinela_instances WHERE id = ?', [id]);
      if (owned.length === 0) return res.status(404).json({ error: 'Instância não encontrada' });
      assertTenantMatch(req.auth, owned[0].tenant_id);
      await pool.query('DELETE FROM sentinela_instances WHERE id = ?', [id]);
      res.json({ success: true, message: 'Instância removida' });
    } catch (e) {
      if (e.statusCode === 403) return res.status(403).json({ error: e.message });
      console.error('delete instance:', e);
      res.status(500).json({ error: 'Falha ao remover instância' });
    }
  });

  return router;
}
```

- [ ] **Step 4: Rodar (passa)**.
- [ ] **Step 5: Commit** — `git commit -m "feat(api): tenant-aware instances router with RBAC scoping"`.

### Task 3.3: Recompor `server/index.js`

Remove a checagem `X-Sentinela-Key` e o `ensureTableExists` (schema agora é responsabilidade das migrations); monta CORS + rotas de auth (públicas) + rotas protegidas por `authenticate`.

**Files:**
- Modify: `server/index.js`
- Test: `test/index.smoke.test.js`

**Interfaces:**
- Consumes: `createAuthRouter`, `authenticate`, `createInstancesRouter`, `corsMiddleware`, `pool`.
- Produces: app Express exportável (`export function createApp(pool)`) + bootstrap `listen` quando executado direto.

- [ ] **Step 1: Teste (falha)**

`test/index.smoke.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { getTestPool, resetSchema } from './helpers/db.js';
import { createApp } from '../server/index.js';

describe('app wiring', () => {
  let app, pool;
  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    await resetSchema();
    pool = getTestPool();
    app = createApp(pool);
  });
  afterAll(() => pool.end());

  it('login é público, instances exige auth', async () => {
    const login = await request(app).post('/api/auth/login').send({ email: 'x', password: 'y' });
    expect([400, 401]).toContain(login.status); // rota existe, sem X-Sentinela-Key
    const inst = await request(app).get('/api/instances');
    expect(inst.status).toBe(401);
  });
});
```

- [ ] **Step 2: Rodar (falha)**.

- [ ] **Step 3: Reescrever `server/index.js`**

```js
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
```

- [ ] **Step 4: Rodar (passa)** — `npm test -- test/index.smoke.test.js`.

- [ ] **Step 5: Commit** — `git commit -m "refactor(api): JWT+CORS wiring, drop static key and runtime table auto-create"`.

### Task 3.4: Frontend — trocar chave estática por login/JWT

Remove `VITE_API_SECRET_KEY` e o header `X-Sentinela-Key`; adiciona armazenamento do JWT e envio `Authorization: Bearer`.

**Files:**
- Modify: `src/services/quepasaApi.js:68-129` (bloco DB API)
- Create: `src/services/authApi.js`

**Interfaces:**
- Produces: `login(email, password) → { token, user }` (guarda token em `localStorage` chave `sentinela_jwt`); `getAuthHeaders()` → `{ 'Content-Type': 'application/json', Authorization: 'Bearer <jwt>' }`; `logout()`.
- Consumes (nas funções `*InstanceApi`): `getAuthHeaders()` em vez de `API_HEADERS`.

- [ ] **Step 1: Criar `src/services/authApi.js`**

```js
const JWT_KEY = 'sentinela_jwt';

export async function login(email, password) {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error('Falha no login');
  const data = await res.json();
  localStorage.setItem(JWT_KEY, data.token);
  return data;
}

export function getToken() { return localStorage.getItem(JWT_KEY); }
export function logout() { localStorage.removeItem(JWT_KEY); }

export function getAuthHeaders() {
  const token = getToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}
```

- [ ] **Step 2: Editar `src/services/quepasaApi.js`** — remover as linhas 70-74 (`API_KEY`/`API_HEADERS`) e importar `getAuthHeaders`. Trocar todo `headers: API_HEADERS` por `headers: getAuthHeaders()` nas 4 funções (`fetchInstancesApi`, `createInstanceApi`, `updateInstanceApi`, `deleteInstanceApi`).

No topo do arquivo:
```js
import { getAuthHeaders } from './authApi';
```
Remover:
```js
const API_KEY = import.meta.env.VITE_API_SECRET_KEY || '';
const API_HEADERS = { 'Content-Type': 'application/json', 'X-Sentinela-Key': API_KEY };
```

- [ ] **Step 3: Build de verificação**

Run: `npm --prefix /Users/felipesaman/Documents/GitHub/sentinela.nosync run build`
Expected: build conclui sem erros de import.

- [ ] **Step 4: Grep de sanidade** — garantir que não restou referência à chave estática:

Run: `grep -rn "X-Sentinela-Key\|VITE_API_SECRET_KEY" /Users/felipesaman/Documents/GitHub/sentinela.nosync/src`
Expected: nenhum resultado.

- [ ] **Step 5: Commit** — `git commit -m "feat(frontend): JWT auth via login, remove static API key"`.

---

## Fase 4 — Seed inicial, aplicação no DB dev e documentação

### Task 4.1: Seed de superadmin + tenant V4Company

Cria o primeiro superadmin e o tenant existente (V4Company). Idempotente. Senha vem de env `SEED_SUPERADMIN_PASSWORD` (não hardcode).

**Files:**
- Create: `migrations/<ts>_seed_bootstrap.cjs` (ou script `scripts/seed.mjs`)
- Test: `test/seed.test.js`

**Interfaces:**
- Produces: 1 tenant `V4Company`; 1 user role=superadmin (tenant_id NULL) com senha vinda de env.

- [ ] **Step 1: Teste (falha)** — após rodar o seed, existe ≥1 superadmin e o tenant V4Company.

- [ ] **Step 2: Rodar (falha)**.

- [ ] **Step 3: Implementar `scripts/seed.mjs`** (roda com `mysql2` + `bcryptjs`, lê env):

```js
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
```

Adicionar script npm: `"seed": "node scripts/seed.mjs"`.

- [ ] **Step 4: Rodar teste (passa)** — o teste chama o mesmo INSERT lógico contra o DB de teste.

- [ ] **Step 5: Commit** — `git commit -m "feat(db): bootstrap seed for superadmin and V4Company tenant"`.

### Task 4.2: Rodar toda a suíte + aplicar migrations no DB de teste

- [ ] **Step 1: Suíte completa**

Run: `npm --prefix /Users/felipesaman/Documents/GitHub/sentinela.nosync test`
Expected: TODOS os testes PASS.

- [ ] **Step 2: Ciclo migrate up/down completo no DB de teste**

```bash
cross-env NODE_ENV=test npx --prefix /Users/felipesaman/Documents/GitHub/sentinela.nosync knex --knexfile knexfile.cjs --env test migrate:latest
cross-env NODE_ENV=test npx --prefix /Users/felipesaman/Documents/GitHub/sentinela.nosync knex --knexfile knexfile.cjs --env test migrate:rollback --all
cross-env NODE_ENV=test npx --prefix /Users/felipesaman/Documents/GitHub/sentinela.nosync knex --knexfile knexfile.cjs --env test migrate:latest
```
Expected: sobe e desce sem erro (reversibilidade validada).

### Task 4.3: Aplicar no DB de dev compartilhado (com checagem de órfãos)

⚠️ Ponto de checkpoint humano antes de rodar contra `143.244.156.195`.

- [ ] **Step 1: Checagem de órfãos (defensiva, mesmo com DB vazio)** — rodar o script de checagem (já validado: 0 órfãos hoje). Se qualquer contagem > 0, PARAR e reportar.

- [ ] **Step 2: Backup lógico do schema atual**

```bash
mysqldump -h 143.244.156.195 -P 3306 -u user_sentinela -p --no-data sentinela > /tmp/sentinela_schema_backup_$(date +%s).sql
```
(Operador digita a senha; não passar `-p<senha>` inline.)

- [ ] **Step 3: Rodar migrations no dev**

Run: `npm --prefix /Users/felipesaman/Documents/GitHub/sentinela.nosync run migrate`
Expected: todas as migrations aplicadas; `knex_migrations` populada.

- [ ] **Step 4: Verificação pós-migration** — rodar o script de inspeção de schema e confirmar PKs compostas + novas tabelas + FKs.

- [ ] **Step 5: Seed do superadmin no dev**

Run: `npm --prefix /Users/felipesaman/Documents/GitHub/sentinela.nosync run seed`
Expected: `Seed OK`.

### Task 4.4: Documentação (`README.md`) e `.env.example` (novas variáveis, sem segredos)

Nota: os valores REAIS de QuePasa/n8n ficam como estão (pendência pré-produção). Aqui só se **acrescentam** as novas variáveis de auth com placeholders.

**Files:**
- Modify/Create: `README.md`
- Modify: `.env.example` (o operador aplica — arquivo bloqueado para o assistente)

**Interfaces:**
- Produces: README com fluxo de login JWT, tabela de variáveis de ambiente, comandos de migration/seed/test.

- [ ] **Step 1: Escrever `README.md`** com seções: Visão geral (read-only), Stack, Setup local, Variáveis de ambiente (DB_*, TEST_DB_*, JWT_SECRET, JWT_EXPIRES_IN, CORS_ORIGINS, SEED_SUPERADMIN_*), Migrations (`npm run migrate`, `migrate:rollback`, `migrate:make`), Testes (`npm test` + docker-compose.test.yml), Fluxo de autenticação (login → JWT → Bearer), RBAC (4 papéis e escopo), Modelo multi-tenant (tenant_id denormalizado, PKs compostas).

- [ ] **Step 2: Instruir operador a acrescentar ao `.env.example`** (placeholders):

```dotenv
# --- Auth ---
JWT_SECRET=troque-por-openssl-rand-hex-32
JWT_EXPIRES_IN=15m
CORS_ORIGINS=http://localhost:3000
# --- Seed inicial ---
SEED_SUPERADMIN_EMAIL=admin@example.com
SEED_SUPERADMIN_PASSWORD=defina-uma-senha-forte
# --- Test DB ---
TEST_DB_HOST=127.0.0.1
TEST_DB_PORT=3307
TEST_DB_USER=sentinela_test
TEST_DB_PASSWORD=sentinela_test
TEST_DB_NAME=sentinela_test
```

- [ ] **Step 3: Commit** — `git commit -m "docs: JWT auth flow, env vars, migrations and RBAC model"`.

### Task 4.5: Finalizar branch

- [ ] **Step 1:** Rodar `npm test` (tudo verde) e `npm run build` (frontend ok).
- [ ] **Step 2:** Abrir PR `feat/fase1-multitenant` → `main` com resumo das mudanças e a lista de pendências pré-produção.

---

## Pendências pré-produção (NÃO nesta fase — registradas para o deploy)

Confirmado com o usuário: os valores atuais são de teste/dev e serão trocados na produção. Antes do deploy de produção:

1. **Rotacionar e sanitizar segredos**: token QuePasa, URL/token do webhook n8n (`n8.v4saman.com`), e-mail interno (`ti.bh@v4company.com`) e URL do servidor — hoje hardcoded em `src/services/quepasaApi.js`, `nginx.conf`, `.env.example`, `docker-compose.yml`. Substituir por variáveis de ambiente/placeholders e gerar credenciais novas.
2. **Token QuePasa via header, não query string**: revisar chamadas em `quepasaApi.js` que passam `?token=...` para evitar vazamento em logs (parcialmente já mitigado pelo proxy `x-quepasa-token`).
3. Avaliar rewrite de histórico git só se a rotação não for suficiente (decisão do usuário: rotação basta, não reescrever histórico).

---

## Self-Review (checagem contra a spec)

**Cobertura da spec:**
- §1 Modelagem multi-tenant + RBAC → Fase 1 (Tasks 1.1–1.5) + `user_instances` adicionada (justificada). Estratégia `ON DELETE` documentada. ✅
- §2 FKs nas tabelas existentes → já existiam (baseline Task 0.4); convertidas para compostas em Task 1.5; checagem de órfãos em Task 4.3 Step 1. ✅
- §3 Índices de performance → `messages.*` já existiam (baseline); `contacts.phone` e `chats.title` adicionados (Task 1.6, tenant-scoped). ✅
- §4 Sistema de migrations formal → Knex (Fase 0). ✅
- §5 Auth JWT + middleware de tenant + remover VITE_API_SECRET_KEY → Fase 2 + Task 3.4. ✅
- §6 Segurança: CORS (Task 3.1) e rate limiting (Task 2.5) FEITOS nesta fase; sanitização de segredos + token-in-query ADIADOS por decisão do usuário (seção Pendências). ✅ (com desvio explícito e aprovado)

**Placeholder scan:** sem TODO/TBD; todo passo com código tem o código completo.

**Type consistency:** `tenantFilter`/`visibleInstanceIds`/`assertTenantMatch` usados com as mesmas assinaturas em Tasks 2.4, 3.2. `getAuthHeaders` definido em 3.4 Step 1 e usado em 3.4 Step 2. `createApp(pool)`, `createAuthRouter(pool)`, `createInstancesRouter(pool)` consistentes entre 2.5, 3.2, 3.3.

**Desvios conscientes da spec (aprovados pelo usuário):**
1. Sanitização/rotação de segredos adiada para pré-produção.
2. `messages` com PK composta `(tenant_id, id)` (derivado da invariante de multi-monitoramento).
3. `user_instances` adicionada além das tabelas listadas (necessária para o escopo do papel "usuario").
