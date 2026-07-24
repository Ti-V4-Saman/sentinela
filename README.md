# Sentinela

Sistema **read-only** de monitoramento de conversas do WhatsApp. Captura mensagens
via webhook da API **QuePasa**, armazena em MySQL e permite auditoria/análise/pesquisa.
O painel **nunca envia nem responde mensagens** — apenas lê.

A partir da Fase 1 o sistema é **multi-tenant** com **RBAC de 4 níveis** e autenticação **JWT**.

## Stack

- **Backend:** Node 20 + Express 5 + `mysql2/promise` (sem ORM no runtime)
- **Frontend:** React 18 + Vite + Tailwind
- **Migrations:** Knex (apenas migrations; runtime segue em `mysql2`)
- **Auth:** JWT (`jsonwebtoken`) + `bcryptjs`
- **Testes:** Vitest + Supertest

## Setup local

```bash
npm install
cp .env.example .env   # preencha os valores (ver abaixo)
npm run migrate        # aplica migrations no banco configurado
npm run seed           # cria o superadmin inicial (usa SEED_SUPERADMIN_*)
npm run server         # backend em :3001
npm run dev            # frontend (Vite) em :3000
```

## Variáveis de ambiente

| Variável | Descrição |
|---|---|
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | Conexão MySQL (banco `sentinela`) |
| `JWT_SECRET` | Segredo de assinatura do JWT (`openssl rand -hex 32`). **Nunca commitar.** |
| `JWT_EXPIRES_IN` | Validade do token (ex.: `15m`) |
| `CORS_ORIGINS` | Origens permitidas do frontend, separadas por vírgula (ex.: `http://localhost:3000`) |
| `SEED_SUPERADMIN_EMAIL` / `SEED_SUPERADMIN_PASSWORD` | Credenciais do superadmin inicial criado por `npm run seed` |

> As variáveis `VITE_QUEPASA_*` (integração QuePasa) permanecem como estão; a sanitização/rotação
> desses valores está prevista para o deploy de produção.

## Migrations

```bash
npm run migrate                 # aplica todas as migrations pendentes
npm run migrate:make -- <nome> -x cjs   # cria nova migration (.cjs obrigatório — projeto é ESM)
npm run migrate:rollback        # reverte o último batch
```

⚠️ **Não rode `migrate:rollback` contra o banco vivo** (`sentinela`) — o `down` do baseline e das
conversões de schema mexem em tabelas reais. As migrations são reversíveis para ambientes novos/vazios.

Todas as migrations vivem em `migrations/` e devem ter extensão **`.cjs`** (o projeto é ESM;
migrations usam `exports.up`/`exports.down` do CommonJS).

## Testes

```bash
npm test          # roda toda a suíte (Vitest)
npm run test:watch
```

Os testes rodam contra o banco `sentinela` configurado no `.env`. **São não-destrutivos:**
testes que tocam o banco rodam dentro de uma transação com `ROLLBACK` (helper `withTx` em
`test/helpers/db.js`) — inserem dados de teste e desfazem tudo, sem persistir. Testes de schema
apenas leem `information_schema` após as migrations serem aplicadas (`applyMigrations`, idempotente).

## Autenticação (JWT)

1. `POST /api/auth/login` com `{ email, password }` → retorna `{ token, user }`.
2. O frontend guarda o token (`localStorage`) e envia `Authorization: Bearer <jwt>` em toda chamada.
3. O middleware `authenticate` valida o token e popula `req.auth = { userId, tenantId, role }`.
4. O login tem **rate limit** (10 req / 15 min por IP) e resposta de tempo uniforme (não vaza
   existência de e-mail).

Não há mais chave estática `X-Sentinela-Key` / `VITE_API_SECRET_KEY` — foram removidas.

**Janela de revogação do JWT:** role/tenant ficam no token e valem por `JWT_EXPIRES_IN`
(15m). Para não deixar um admin rebaixado/desativado manter poder de escrita nessa janela,
as rotas de **mutação** (`POST/PUT/DELETE /api/instances`) **recarregam `role`/`status` do
banco** a cada requisição (usuário `disabled` → 401; papel rebaixado → 403). As rotas de
leitura aceitam a janela de 15m como período de revogação. Uma denylist/versão de token por
requisição fica como melhoria futura.

Instância acessada por outro tenant retorna **404** (não 403), para não revelar a existência
de IDs de outros tenants. O `token` da instância (credencial QuePasa) só é retornado a
admin/superadmin — gestor/usuario (read-only) não o recebem.

## RBAC (4 papéis)

| Papel | Escopo |
|---|---|
| **superadmin** | `tenant_id` NULL; acesso irrestrito a todos os tenants |
| **admin** | 1 tenant; vê e gerencia todas as instâncias/usuários/equipes do próprio tenant |
| **gestor** | Vê conversas das instâncias das equipes às quais está vinculado (N:N via `team_managers` → `team_instances`) |
| **usuario** | Vê apenas as próprias instâncias (via `user_instances`) |

O escopo é aplicado por um helper central (`server/middleware/tenantScope.js`):
`tenantFilter` injeta o filtro por tenant em toda query, e `visibleInstanceIds` resolve o
conjunto de instâncias visíveis por papel. Mutações de instância (POST/PUT/DELETE) exigem
**admin/superadmin**; gestor/usuario são read-only.

## Modelo multi-tenant

`tenant_id` é **denormalizado** em todas as tabelas de dados:

- `contacts` e `chats`: PK composta `(tenant_id, id)` — mesmo telefone/grupo isolado por tenant.
- `messages`: PK composta `(tenant_id, id)` + FKs compostas `(tenant_id, chat_id)` e `(tenant_id, contact_id)`.
- `mentions`: `tenant_id` + FK composta `(tenant_id, message_id)`.
- `instances` / `sentinela_instances`: `tenant_id` como FK simples (1 instância = 1 tenant).

Ver o plano completo em `docs/superpowers/plans/2026-07-23-sentinela-fase1-multitenant.md`.

## Pendências pré-produção

Sanitizar/rotacionar segredos reais (token QuePasa, webhook n8n, e-mail interno, URL do servidor)
hoje presentes em `src/services/quepasaApi.js`, `nginx.conf`, `.env.example`, `docker-compose.yml`
e no histórico git. Valores atuais são de teste/dev — trocar por credenciais novas no deploy de produção.
