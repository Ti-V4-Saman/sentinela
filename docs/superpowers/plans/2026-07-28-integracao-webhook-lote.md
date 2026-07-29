# Etapa B — Integração por webhook em lote (Configurações > Integrações)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar, por tenant, uma integração que exporta em lote (diário) as conversas monitoradas para uma URL externa, assinada por HMAC, idempotente, com defesa SSRF e desligada por padrão no ambiente.

**Architecture:** Backend Express 5 + `mysql2/promise` (pool) — 3 tabelas novas (`tenant_integrations`, `integration_delivery_batches`, `integration_delivery_attempts`), módulos puros de segurança (secret, SSRF, HMAC, janela/idempotência, payload/chunk, entrega/retry), rotas tenant-safe (`requireActor` + `router.param`), auditoria por listas fechadas, e um comando de job idempotente (`npm run integrations:dispatch`). Frontend React 18 — tela `Configurações > Integrações` no design system real, escopada por `TenantContext` (superadmin só no modo cliente; admin no próprio tenant). Migração Knex `.cjs` defensiva/reversível.

**Tech Stack:** Node crypto (HMAC-SHA256, randomBytes, timingSafeEqual, scrypt/sha256 para secret), Node dns/promises + net (SSRF), Express 5, mysql2/promise, Knex (migrations), Vitest + supertest, Vite/React 18 + Tailwind v4 + shadcn/ui.

## Global Constraints

- **Read-only sobre dados reais:** o sistema só LÊ mensagens/conversas para montar o lote; nunca escreve em tabelas de captura (`messages`, `sentinela_instances` etc.).
- **Isolamento por tenant é invariante de segurança:** nenhuma rota/consulta retorna dados de outro tenant. RBAC recarregado do banco em mutações via `requireActor(pool, roles)`. Cross-tenant/inexistente → `404` (não revela existência).
- **Superadmin** só abre/configura Integrações **no modo cliente** (tenant vem do `TenantContext`; nunca na visão global); backend revalida o tenant. **Admin** opera só o próprio tenant; **não** aceita tenant por URL/body. **Gestor/usuário:** sem acesso (`403`).
- **Secret:** criptograficamente seguro; **nunca** devolvido integral após criação; só mascarado; nunca em logs, auditoria, frontend ou git. Armazenado como hash (não reversível para exibição) + coluna mascarada de exibição.
- **Flag global `EXTERNAL_INTEGRATIONS_ENABLED`:** default `false`. Quando ≠ exatamente `'true'`: **nenhum POST externo** é executado (nem job, nem reenvio manual); a UI informa "desativado no ambiente"; **nenhuma tentativa falsa aparece como entrega bem-sucedida**. Criar/editar config continua disponível.
- **SSRF:** URL validada no backend a cada uso (criação, teste, entrega). Em ambiente online: só HTTPS; bloquear localhost/`127.0.0.0/8`/`0.0.0.0`/privadas IPv4/link-local/metadata/IPv6 local-privada-link-local; resolver DNS e validar IPs resultantes; sem redirect para destino bloqueado; limitar nº de redirects e tamanho da URL.
- **Sucesso de entrega:** apenas HTTP `200–299`. Qualquer outro código, timeout ou erro = falha.
- **Idempotência:** nunca dois batches para (tenant, integração, período, schema_version). Chunk mantém idempotência por parte.
- **Migration:** `.cjs`, defensiva (valida objetos de mesmo nome, erro explícito em estado incompatível), reversível (up/down), validada **somente no banco de teste**. **Nunca** aplicar em produção nem rodar rollback no banco vivo.
- **Auditoria:** só metadados seguros; ações/recur­sos em listas fechadas (`AUDIT_ACTIONS`/`AUDIT_RESOURCES`). Nunca secret/token/conteúdo.
- **UI:** design system real (`docs/DESIGN-SYSTEM.md` — regra bloqueante, checklist seção 9). Textos pt-BR. Nada de `window.alert/confirm/prompt`. Sem cor hardcoded. `ia`=roxo.
- **Segredos** só em `.env` (git-ignored). `schema_version` do payload = `1` nesta etapa.

---

## Constantes compartilhadas (usar verbatim)

```
SCHEMA_VERSION = 1
DELIVERY_TIMEOUT_MS = 15000
DELIVERY_MAX_ATTEMPTS = 5
DELIVERY_BACKOFF = base 2s, fator 3, jitter — atrasos-alvo: 2s, 6s, 18s, 54s (documentado; o job não bloqueia esperando — reagenda por vencimento)
MAX_REDIRECTS = 3
MAX_URL_LEN = 2048
CHUNK_MAX_MESSAGES = 5000
CHUNK_MAX_BYTES = 5_000_000   // 5 MB por parte (payload serializado)
SUCCESS_RANGE = [200, 299]
Headers de entrega: X-Sentinela-Signature, X-Sentinela-Timestamp, X-Sentinela-Delivery, X-Sentinela-Schema-Version, Idempotency-Key
Assinatura: HMAC-SHA256(secret, `${timestamp}.${rawBody}`) em hex, header `sha256=<hex>`
```

## File Structure

**Backend (novos):**
- `server/integrations/secret.js` — geração/hash/verificação/máscara do secret.
- `server/integrations/ssrf.js` — validação de URL + resolução DNS + guarda de IP.
- `server/integrations/signature.js` — HMAC assinar/verificar (timing-safe).
- `server/integrations/window.js` — janela determinística (timezone/DST) + chave de idempotência.
- `server/integrations/payload.js` — montagem do payload (allow-list de campos) + chunking determinístico.
- `server/integrations/delivery.js` — entrega HTTP (timeout, redirects seguros, ret/backoff, gate global, erro sanitizado).
- `server/integrations/repo.js` — acesso a dados (CRUD config, batches, attempts) tenant-safe.
- `server/routes/integrations.js` — router factory tenant-safe.
- `server/jobs/dispatch-integrations.js` — comando de job idempotente (lock, exit code).
- `server/integrations/config.js` — leitura das flags/constантes de ambiente (`EXTERNAL_INTEGRATIONS_ENABLED`, timeouts).

**Backend (modificados):**
- `server/index.js` — montar `/api/integrations`.
- `server/audit.js` — novas ações/recursos de integração.
- `package.json` — script `integrations:dispatch`.

**Migration:**
- `migrations/20260801120000_integrations.cjs` — 3 tabelas defensivas/reversíveis.

**Frontend (novos):**
- `src/views/IntegrationsView.tsx` — tela principal.
- `src/components/integrations/IntegrationConfigForm.tsx` — form de configuração.
- `src/components/integrations/BatchHistory.tsx` — histórico de lotes + tentativas + reenvio.

**Frontend (modificados):**
- `src/services/adminApi.js` — funções de API de integração.
- `src/components/shell/Sidebar.tsx` — item "Integrações".
- `src/App.jsx` — render da view.

**Testes (novos):**
- `test/integrations-secret.test.js`, `test/integrations-ssrf.test.js`, `test/integrations-signature.test.js`, `test/integrations-window.test.js`, `test/integrations-payload.test.js`, `test/integrations-delivery.test.js`, `test/integrations-routes.test.js`, `test/integrations-migration.test.js`, `test/integrations-dispatch.test.js`.

---

## Task 1: Migration das 3 tabelas (defensiva + reversível)

**Files:**
- Create: `migrations/20260801120000_integrations.cjs`
- Test: `test/integrations-migration.test.js`

**Interfaces:**
- Produces: tabelas `tenant_integrations`, `integration_delivery_batches`, `integration_delivery_attempts` com o schema abaixo. Usadas por todas as tasks seguintes.

**Schema (DDL alvo):**

```sql
CREATE TABLE tenant_integrations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id BIGINT UNSIGNED NOT NULL,
  type ENUM('webhook_batch') NOT NULL DEFAULT 'webhook_batch',
  active TINYINT(1) NOT NULL DEFAULT 0,
  target_url VARCHAR(2048) NOT NULL,
  secret_hash VARCHAR(255) NULL,          -- sha256(secret) hex; NULL antes de gerar
  secret_masked VARCHAR(64) NULL,         -- ex.: 'whsec_••••…ab12'
  secret_set_at TIMESTAMP NULL,
  frequency ENUM('daily') NOT NULL DEFAULT 'daily',
  run_at_time CHAR(5) NOT NULL DEFAULT '03:00',   -- 'HH:MM'
  timezone VARCHAR(64) NOT NULL DEFAULT 'America/Sao_Paulo',
  include_direct TINYINT(1) NOT NULL DEFAULT 1,
  include_groups TINYINT(1) NOT NULL DEFAULT 1,
  include_from_me TINYINT(1) NOT NULL DEFAULT 1,
  include_audio_transcripts TINYINT(1) NOT NULL DEFAULT 0,
  last_run_window_end DATETIME NULL,      -- fim da última janela processada (UTC)
  updated_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ti_tenant_type (tenant_id, type),
  KEY idx_ti_active (active),
  CONSTRAINT fk_ti_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_ti_updated_by FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE integration_delivery_batches (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id BIGINT UNSIGNED NOT NULL,
  integration_id BIGINT UNSIGNED NOT NULL,
  schema_version INT UNSIGNED NOT NULL,
  window_start DATETIME NOT NULL,        -- UTC
  window_end DATETIME NOT NULL,          -- UTC
  part INT UNSIGNED NOT NULL DEFAULT 1,
  part_total INT UNSIGNED NOT NULL DEFAULT 1,
  idempotency_key VARCHAR(120) NOT NULL,
  status ENUM('pending','delivering','delivered','failed') NOT NULL DEFAULT 'pending',
  conversation_count INT UNSIGNED NOT NULL DEFAULT 0,
  message_count INT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_batch_idem (idempotency_key),
  UNIQUE KEY uq_batch_window (tenant_id, integration_id, window_start, window_end, schema_version, part),
  KEY idx_batch_tenant_status (tenant_id, status),
  KEY idx_batch_integration (integration_id, window_end),
  CONSTRAINT fk_batch_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_batch_integration FOREIGN KEY (integration_id) REFERENCES tenant_integrations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE integration_delivery_attempts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id BIGINT UNSIGNED NOT NULL,
  batch_id BIGINT UNSIGNED NOT NULL,
  attempt_no INT UNSIGNED NOT NULL,
  status ENUM('success','failure') NOT NULL,
  http_code INT NULL,
  duration_ms INT UNSIGNED NULL,
  error TEXT NULL,                       -- sanitizado (sem secret/URL crua/corpo)
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_attempt (batch_id, attempt_no),
  KEY idx_attempt_tenant (tenant_id, created_at),
  CONSTRAINT fk_attempt_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_attempt_batch FOREIGN KEY (batch_id) REFERENCES integration_delivery_batches(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

**Padrão defensivo (obrigatório):** seguir `migrations/20260729120000_access_logs.cjs` — helpers `tableExists`/`columnRow`/`indexExists`/`fkExists` via `information_schema`; em `up`, criar se ausente; se a tabela já existir, validar colunas essenciais e **`throw new Error('... INCOMPATIBLE')`** em divergência de tipo; adicionar colunas/índices/FKs ausentes. `down` faz `DROP TABLE IF EXISTS` na ordem inversa das FKs (attempts → batches → tenant_integrations).

- [ ] **Step 1: Escrever o teste de migration** (`test/integrations-migration.test.js`): aplica `knex.migrate.latest()` num schema temporário/transação e assere que as 3 tabelas existem com as colunas/uniques-chave (`uq_ti_tenant_type`, `uq_batch_idem`, `uq_batch_window`, `uq_attempt`). Testa reversibilidade: rollback dessa migration derruba as 3 tabelas (rodar **só** no banco de teste, via knex isolado — não no pool compartilhado). Testa incompatibilidade: se `tenant_integrations` existir com `target_url INT`, `up` lança erro explícito.
- [ ] **Step 2: Rodar o teste — deve falhar** (`npx vitest run test/integrations-migration.test.js`). Esperado: falha (migration inexistente).
- [ ] **Step 3: Escrever a migration** `20260801120000_integrations.cjs` no padrão defensivo acima.
- [ ] **Step 4: Rodar o teste — deve passar.**
- [ ] **Step 5: Commit** (`feat(integrations): migration defensiva das 3 tabelas`).

---

## Task 2: Módulo de secret (`server/integrations/secret.js`)

**Files:**
- Create: `server/integrations/secret.js`
- Test: `test/integrations-secret.test.js`

**Interfaces (Produces):**
```js
generateSecret(): { plaintext: string, hash: string, masked: string }
// plaintext: `whsec_` + 40+ chars base64url de 32 bytes randomBytes (nunca persistido cru)
// hash: sha256(plaintext) hex — persistido em secret_hash
// masked: `whsec_••••` + últimos 4 chars — persistido em secret_masked
hashSecret(plaintext): string          // sha256 hex
maskFromPlaintext(plaintext): string   // `whsec_••••<last4>`
verifySecret(plaintext, hash): boolean // timingSafeEqual sobre os digests
```

- [ ] **Step 1: Teste** — `generateSecret()` produz plaintext ≥ 32 bytes de entropia, prefixo `whsec_`, `hash === hashSecret(plaintext)`, `masked` não revela mais que 4 chars finais e não contém o plaintext; dois secrets diferem; `verifySecret` true para par correto, false para errado (e é timing-safe: usa `crypto.timingSafeEqual`).
- [ ] **Step 2: Rodar — falha.**
- [ ] **Step 3: Implementar** com `crypto.randomBytes`, `createHash('sha256')`, `timingSafeEqual`.
- [ ] **Step 4: Rodar — passa.**
- [ ] **Step 5: Commit** (`feat(integrations): secret cripto-seguro com hash e máscara`).

---

## Task 3: Defesa SSRF (`server/integrations/ssrf.js`)

**Files:**
- Create: `server/integrations/ssrf.js`
- Test: `test/integrations-ssrf.test.js`

**Interfaces (Produces):**
```js
validateUrlSyntax(url, { allowHttp }): { ok: boolean, reason?: string }
// checa: comprimento <= MAX_URL_LEN; parse; protocolo https (http só se allowHttp p/ dev/localhost em teste)
isBlockedIp(ip): boolean   // IPv4/IPv6: loopback, 0.0.0.0, privadas (10/8,172.16/12,192.168/16), CGNAT 100.64/10, link-local 169.254/16 + fe80::/10, metadata 169.254.169.254, ULA fc00::/7, ::1, mapped ::ffff:
assertSafeUrl(url, { allowHttp }): Promise<{ ok: boolean, reason?: string, ips?: string[] }>
// valida sintaxe; resolve DNS (dns.promises.lookup all:true); TODOS os IPs resolvidos devem passar isBlockedIp=false; senão bloqueia
safeFetchGuard(): { maxRedirects: MAX_REDIRECTS, checkRedirectTarget(locationUrl): Promise<boolean> }
```
Ambiente: `allowHttp` = `false` em produção/homolog; a flag deriva de `EXTERNAL_INTEGRATIONS_ENABLED`/NODE_ENV — em teste permitir HTTP para o mock local, mas os testes de SSRF exercitam o modo estrito.

- [ ] **Step 1: Testes (vetores)** — bloqueia: `http://x` (sem https no modo estrito), `https://localhost`, `https://127.0.0.1`, `https://127.0.0.5`, `https://0.0.0.0`, `https://10.1.2.3`, `https://172.16.0.1`, `https://192.168.1.1`, `https://169.254.169.254` (metadata), `https://[::1]`, `https://[fe80::1]`, `https://[fc00::1]`, URL > 2048 chars. Aceita: `https://example.com` (mock DNS → IP público). DNS resolvendo para IP privado → **bloqueado** (mockar `dns.promises.lookup`). Redirect para `http://169.254.169.254` → `checkRedirectTarget` false.
- [ ] **Step 2: Rodar — falha.**
- [ ] **Step 3: Implementar** com `net.isIP`, parsing de faixas, `dns.promises.lookup(host,{all:true})`. Injetar o resolver como parâmetro para testar sem rede real.
- [ ] **Step 4: Rodar — passa.**
- [ ] **Step 5: Commit** (`feat(integrations): defesa SSRF (URL + DNS + IP guard)`).

---

## Task 4: Assinatura HMAC (`server/integrations/signature.js`)

**Files:**
- Create: `server/integrations/signature.js`
- Test: `test/integrations-signature.test.js`

**Interfaces (Produces):**
```js
sign(rawBody: string, secretPlaintext: string, timestamp: string): string
// retorna `sha256=<hex>` de HMAC-SHA256(secret, `${timestamp}.${rawBody}`)
verify(rawBody, secretPlaintext, timestamp, signatureHeader): boolean  // timingSafeEqual
buildHeaders({ rawBody, secret, timestamp, deliveryId, schemaVersion, idempotencyKey }): Record<string,string>
```
Documentar no header do arquivo como o receptor valida (recomputar HMAC sobre `timestamp.rawBody` e comparar timing-safe; rejeitar timestamp fora de janela de tolerância).

- [ ] **Step 1: Testes** — assinatura estável para entrada fixa (vetor conhecido); `verify` true p/ assinatura correta e false se body/secret/timestamp mudam; usa comparação timing-safe; `buildHeaders` inclui os 5 headers e a assinatura cobre o corpo EXATO enviado.
- [ ] **Step 2: Rodar — falha.** **Step 3: Implementar** (`crypto.createHmac`). **Step 4: Rodar — passa.** **Step 5: Commit** (`feat(integrations): assinatura HMAC-SHA256 timing-safe`).

---

## Task 5: Janela determinística + idempotência (`server/integrations/window.js`)

**Files:**
- Create: `server/integrations/window.js`
- Test: `test/integrations-window.test.js`

**Interfaces (Produces):**
```js
computeDueWindow(cfg, nowUtc): { start: Date, end: Date, dueAt: Date } | null
// Para frequency='daily' + run_at_time + timezone: a janela é o DIA anterior completo
// no timezone da integração [00:00, 24:00), convertido para UTC. dueAt = hoje run_at_time no tz.
// Retorna null se a janela já foi processada (cfg.last_run_window_end >= end) ou ainda não venceu (now < dueAt).
idempotencyKey({ tenantId, integrationId, windowStart, windowEnd, schemaVersion, part }): string
// determinística e estável: `t{tenant}-i{integration}-{startISO}_{endISO}-v{schema}-p{part}`; <=120 chars
manualResendWindow(batch): { start, end }  // reusa a janela do batch (mesma idempotência)
```
DST: usar `Intl.DateTimeFormat`/offset por timezone (sem libs externas) — documentar que a janela é definida pelas fronteiras de dia local; em dias de mudança de horário a janela tem 23h/25h e isso é intencional. `nowUtc` é injetável (testes passam data fixa; código de produção passa `new Date()` do chamador — **não** usar `Date.now()` dentro de módulos puros testáveis; receber como argumento).

- [ ] **Step 1: Testes** — janela do dia anterior correta em `America/Sao_Paulo`; `computeDueWindow` retorna null antes de `dueAt` e não-null depois; retorna null se `last_run_window_end` cobre a janela (idempotência de janela); `idempotencyKey` idêntica para mesmos inputs e distinta ao mudar qualquer campo (tenant/integração/período/schema/part); comportamento em data de DST documentado por teste.
- [ ] **Step 2–5:** falha → implementar → passa → commit (`feat(integrations): janela determinística + chave de idempotência`).

---

## Task 6: Payload + chunking (`server/integrations/payload.js`)

**Files:**
- Create: `server/integrations/payload.js`
- Test: `test/integrations-payload.test.js`

**Interfaces (Consumes):** linhas de mensagens já lidas do banco (a query vive em `repo.js`, Task 7/8) — o builder recebe arrays em memória para ser puro/testável.
**Produces:**
```js
buildPayload({ tenant, integration, window, conversations, messages, schemaVersion }): object
// Estrutura (allow-list — SÓ estes campos):
// { schema_version, batch: { id?, tenant_id, window_start, window_end, part, part_total },
//   conversations: [{ chat_id, is_group, contact_ref? }],
//   messages: [{ chat_id, external_id, direction('in'|'out'), type, timestamp,
//                text?(se include e autorizado), transcript?(se include_audio_transcripts) }] }
chunkPayload(payload, { maxMessages, maxBytes }): object[]
// divide messages em partes determinísticas (ordenadas por timestamp,external_id);
// cada parte carrega part/part_total; nunca trunca silenciosamente; recomputa idempotencyKey por parte
```
**Deny-list explícita (nunca incluir):** notas internas, tokens, secrets, senhas, `capture_wid`, payloads de auth, dados de auditoria, IDs internos desnecessários, dados de outro tenant. A montagem filtra por tenant do batch.

- [ ] **Step 1: Testes** — payload só contém campos da allow-list (assert que `capture_wid`, `secret`, `token`, `password`, `internal_note` **não** aparecem em `JSON.stringify`); `direction` derivado de `from_me`; `text` omitido quando não autorizado; `transcript` só quando `include_audio_transcripts`; chunking divide por contagem e por bytes, soma das partes = total (sem perda), `part_total` correto, cada parte é determinística (mesma entrada → mesma divisão), idempotencyKey por parte distinta.
- [ ] **Step 2–5:** falha → implementar → passa → commit (`feat(integrations): builder de payload com allow-list e chunking`).

---

## Task 7: Repo de dados + entrega (`server/integrations/repo.js`, `delivery.js`, `config.js`)

**Files:**
- Create: `server/integrations/config.js`, `server/integrations/repo.js`, `server/integrations/delivery.js`
- Test: `test/integrations-delivery.test.js`

**Interfaces:**
`config.js` (Produces): `externalIntegrationsEnabled(): boolean` (=== 'true'), `deliveryConfig()` (timeouts/limites/constantes acima), `isProdLike()`.
`repo.js` (Produces, tenant-safe — toda função recebe `tenantId` e filtra por ele):
```js
getConfig(pool, tenantId), upsertConfig(pool, tenantId, patch, actorId),
rotateSecret(pool, tenantId, {hash,masked}), listBatches(pool, tenantId, {page,limit}),
getBatch(pool, tenantId, batchId), listAttempts(pool, tenantId, batchId),
createBatch(pool, {...}) // idempotente: INSERT ... ON DUPLICATE KEY → retorna existente
recordAttempt(pool, {...}), setBatchStatus(pool, tenantId, batchId, status),
loadWindowData(pool, tenantId, integration, window) // LÊ conversas/mensagens (read-only) respeitando include_*
```
`delivery.js` (Produces):
```js
deliverBatch({ pool, integration, secretPlaintext, batchRow, rawBody, now, fetchImpl }): Promise<{status, http_code, duration_ms, error?}>
// 1) se !externalIntegrationsEnabled(): NÃO faz POST; grava attempt status='failure', http_code=null,
//    error='EXTERNAL_INTEGRATIONS_DISABLED'; retorna sem simular sucesso.
// 2) assertSafeUrl no target (bloqueio SSRF a cada entrega); redirects manuais (max 3) revalidando destino.
// 3) fetch com AbortController timeout DELIVERY_TIMEOUT_MS; sucesso só 200–299.
// 4) mede duration; erro sanitizado (sem body de resposta, sem URL crua, sem secret).
runWithRetries(...) // aplica DELIVERY_MAX_ATTEMPTS; NÃO loga corpo completo
```
Gate de reenvio manual e concorrência: `delivery` recebe um lock (Task 8/10). `fetchImpl` injetável para teste (mock).

- [ ] **Step 1: Testes** — com `EXTERNAL_INTEGRATIONS_ENABLED` desligado, `deliverBatch` **não** chama `fetchImpl` e grava failure `EXTERNAL_INTEGRATIONS_DISABLED` (nunca success); ligado + mock 200 → success + duration; mock 500 → failure; mock timeout (fetch que rejeita/aborta) → failure com erro sanitizado (sem corpo); código 302 para IP privado → bloqueado; erro nunca contém secret nem body; `createBatch` duplicado retorna o mesmo id (idempotência).
- [ ] **Step 2–5:** falha → implementar → passa → commit (`feat(integrations): repo tenant-safe + entrega com gate/SSRF/retry`).

---

## Task 8: Rotas API (`server/routes/integrations.js`) + auditoria + montagem

**Files:**
- Create: `server/routes/integrations.js`
- Modify: `server/index.js` (montar `/api/integrations`), `server/audit.js` (novas ações/recursos)
- Test: `test/integrations-routes.test.js`

**Auditoria — adicionar a `AUDIT_ACTIONS`:** `create_integration`, `update_integration`, `toggle_integration`, `regenerate_integration_secret`, `test_integration`, `resend_integration_batch`, `run_integration_batch`, `deliver_integration` (com status ok/failure). **A `AUDIT_RESOURCES`:** `integration`, `integration_batch`.

**Endpoints (todos `requireActor(pool, ['admin','superadmin'])`, tenant resolvido server-side):**
- Determinação de tenant: **admin** → `req.actor.tenant_id` (ignora query/body tenant). **superadmin** → `tenant_id` obrigatório na query (equivale ao modo cliente); sem ele → `400`/estado global não permitido. Revalidar existência do tenant (`404` se inexistente).
- `GET /api/integrations` → config do tenant (secret **mascarado**, nunca hash/plaintext) + flag `externalEnabled`.
- `PUT /api/integrations` → criar/atualizar config (valida URL via `assertSafeUrl`; valida `run_at_time`/`timezone`/`include_*`). Auditar.
- `POST /api/integrations/secret` → (re)gerar secret: retorna o **plaintext UMA vez** + masked; persiste só hash+masked. Auditar `regenerate_integration_secret` (sem o valor).
- `POST /api/integrations/test` → teste controlado: valida URL/SSRF; se `externalEnabled` monta e envia um payload de teste mínimo assinado (sem dados reais de mensagens — usa amostra sintética marcada `test:true`); se desligado, retorna `disabled` sem POST. **Rate-limited.** Auditar.
- `GET /api/integrations/batches?page=&limit=` → lista paginada (tenant-safe).
- `GET /api/integrations/batches/:id/attempts` → tentativas do batch (tenant-safe; `404` cross-tenant).
- `POST /api/integrations/batches/:id/resend` → reenvio: bloqueado se `externalEnabled` desligado (mensagem clara) ou se já `delivering` (lock anti-concorrência). **Rate-limited.** Auditar.
- Respostas **nunca** incluem `secret_hash`/plaintext. Paginação padrão (DEFAULT_LIMIT=20, MAX_LIMIT=100). Rate-limit simples (in-memory por tenant+ação) nas ações `test` e `resend`.

- [ ] **Step 1: Testes (supertest + withTx)** — matriz RBAC: superadmin com `tenant_id` OK; superadmin **sem** `tenant_id` (visão global) → bloqueado; admin opera só o próprio tenant, `tenant_id` de outro no query/body é **ignorado** (escopa no próprio); gestor/usuario → `403`; cross-tenant em `/batches/:id/attempts` → `404`; `GET`/`PUT` nunca retornam secret; `POST /secret` retorna plaintext uma vez e o `GET` seguinte só mascarado; URL inválida/SSRF no `PUT` → `400`; com flag desligada, `resend`/`test` não entregam (sem success falso); paginação de batches; auditoria gravada com metadados seguros (sem secret).
- [ ] **Step 2–5:** falha → implementar rotas + montar + audit → passa → commit (`feat(integrations): API tenant-safe + auditoria`).

---

## Task 9: Job de despacho (`server/jobs/dispatch-integrations.js`) + script

**Files:**
- Create: `server/jobs/dispatch-integrations.js`
- Modify: `package.json` (script `integrations:dispatch`)
- Test: `test/integrations-dispatch.test.js`

**Comportamento:** localizar integrações `active=1` cuja janela venceu (`computeDueWindow` ≠ null); para cada, montar batch(es) idempotente(s) (`createBatch` + chunk), tentar entregas se `externalEnabled` (senão registra estado sem success falso), respeitar lock anti-concorrência (arquivo lock ou `GET_LOCK` do MySQL) para impedir 2 execuções simultâneas, retornar exit code coerente (0 sucesso/sem trabalho; ≠0 se houve falha de entrega), logs **sanitizados**. Atualiza `last_run_window_end` só após criar o batch da janela (idempotência entre execuções). **Não** altera cron do servidor; documentar cron recomendado em comentário/README.

- [ ] **Step 1: Testes** — com integração ativa vencida + mock fetch 200: cria batch, entrega success, atualiza `last_run_window_end`, exit 0; segunda execução no mesmo dia **não** cria batch duplicado (idempotência) e não reenvia; flag desligada → cria batch mas não entrega (sem success falso), exit refletindo bloqueio; duas execuções concorrentes → a segunda aborta pelo lock. Usar `withTx` + injeção de `now` e `fetchImpl`.
- [ ] **Step 2–5:** falha → implementar → passa → commit (`feat(integrations): job idempotente de despacho`).

---

## Task 10: Frontend — API service + Sidebar + App wiring

**Files:**
- Modify: `src/services/adminApi.js`, `src/components/shell/Sidebar.tsx`, `src/App.jsx`
- (View real na Task 11.)

**adminApi.js — adicionar:**
```js
export const getIntegration = (tenantId) => req(`/api/integrations${qs({ tenant_id: tenantId })}`);
export const saveIntegration = (tenantId, body) => req(`/api/integrations${qs({ tenant_id: tenantId })}`, { method:'PUT', body: JSON.stringify(body) });
export const regenerateIntegrationSecret = (tenantId) => req(`/api/integrations/secret${qs({ tenant_id: tenantId })}`, { method:'POST' });
export const testIntegration = (tenantId) => req(`/api/integrations/test${qs({ tenant_id: tenantId })}`, { method:'POST' });
export const listIntegrationBatches = (tenantId, page, limit) => req(`/api/integrations/batches${qs({ tenant_id: tenantId, page, limit })}`);
export const listIntegrationAttempts = (tenantId, batchId) => req(`/api/integrations/batches/${batchId}/attempts${qs({ tenant_id: tenantId })}`);
export const resendIntegrationBatch = (tenantId, batchId) => req(`/api/integrations/batches/${batchId}/resend${qs({ tenant_id: tenantId })}`, { method:'POST' });
```
(`qs` helper já existe no arquivo; para admin o backend ignora `tenant_id`.)

**Sidebar.tsx:** adicionar a `NAV_SETTINGS` `{ key: 'integrations', label: 'Integrações', icon: Plug, roles: ['superadmin','admin'] }` (importar `Plug` de lucide-react) e, no filtro `visibleSettings`, aplicar regra igual a `instances`: se `isSuper` mostrar só quando `activeTenant` definido; admin sempre.

**App.jsx:** `activeView === 'integrations' && <IntegrationsView key={scopeKey} tenantId={scopeTid} />` (import lazy/estático como as demais views); incluir 'integrations' na limpeza ao trocar/sair de tenant.

- [ ] **Step 1:** (sem TDD unitário de UI — validado no build + Task 12) implementar as 3 modificações.
- [ ] **Step 2:** `npm run build` passa.
- [ ] **Step 3: Commit** (`feat(integrations): api service + nav + wiring`).

---

## Task 11: Frontend — Tela de Integrações (DESIGN SYSTEM — regra bloqueante)

**Files:**
- Create: `src/views/IntegrationsView.tsx`, `src/components/integrations/IntegrationConfigForm.tsx`, `src/components/integrations/BatchHistory.tsx`

**⛔ Antes de escrever qualquer arquivo desta task, LER `docs/DESIGN-SYSTEM.md` na íntegra e, ao final, percorrer o checklist da seção 9 e reportá-lo explicitamente.**

**Requisitos de tela:** usar componentes reais (`ui/*`, `field/*`, `data-table`, `StatusBadge`, `Switch`, `Dialog`, `useToast`, `useConfirm`). Exibir:
- Status ativa/inativa (Switch); **aviso destacado quando `externalEnabled=false`** ("Integração externa desativada no ambiente — configuração permitida, envios bloqueados") com tom `warning`.
- URL de destino; secret **mascarado** (nunca o valor) + botão "Regenerar" (mostra o plaintext UMA vez num Dialog com aviso de copiar agora; `useConfirm` antes de regenerar pois invalida o anterior); frequência (diária), horário (`HH:MM`), timezone (select), opções de conteúdo (include_direct/groups/from_me/audio_transcripts como Switches).
- Botões: Salvar; Regenerar secret; Enviar teste (desabilitado/expl. quando `externalEnabled=false`).
- Histórico de lotes (tabela paginada): período, status (StatusBadge), part/part_total, contagens; expandir → tentativas (nº, status, http_code, duração, erro sanitizado); ação Reenviar (bloqueada quando desligado/`delivering`).
- Estados: loading (Skeleton), vazio (empty state), erro (mensagem + retry). **Nunca** exibir exemplo com mensagem real (usar rótulos/contagens, não conteúdo de mensagem).
- Superadmin: a tela só é alcançável no modo cliente (Sidebar já garante); se `isGlobalView`, mostrar `SelectClientPrompt`.

- [ ] **Step 1:** Ler DESIGN-SYSTEM.md; implementar os 3 componentes.
- [ ] **Step 2:** `npm run build` passa (lint).
- [ ] **Step 3:** Reportar checklist seção 9. **Step 4: Commit** (`feat(integrations): tela Configurações > Integrações (design system)`).

---

## Task 12: Publicação e validação (sem merge)

**Files:** nenhum de produto; usa `.env`, banco de teste, endpoint mock.

- [ ] **Step 1:** Suíte completa `npm test` verde.
- [ ] **Step 2:** `npm run build` OK.
- [ ] **Step 3:** Scan de segredos (grep por `whsec_`, chaves, tokens no diff; confirmar `.env` não commitado; nenhum secret em código/fixtures).
- [ ] **Step 4:** Aplicar **somente no banco online de testes** a nova migration (`npm run migrate`), preservando dados sintéticos; confirmar 13 migrations aplicadas, 0 pendentes. **Não** aplicar em outro banco.
- [ ] **Step 5:** Validação com **endpoint mock** (servidor HTTP local que valida HMAC timing-safe e responde 200): com `EXTERNAL_INTEGRATIONS_ENABLED=true` só no shell local, rodar `npm run integrations:dispatch` para um tenant sintético e conferir entrega assinada + registro de attempt; depois desligar. **Não** habilitar integrações externas reais nem tocar cron do servidor.
- [ ] **Step 6:** Remover resíduos de QA (batches/attempts/config sintéticos criados na validação; `access_logs` de teste).
- [ ] **Step 7:** Abrir PR (base `main`), **sem merge**. Corpo com o relatório completo (ver seção 18 do spec).

---

## Self-Review (checklist do plano)

- Cobertura do spec: §5 config (Task 8/11), §6 SSRF (Task 3), §7 flag global (Task 7/8/11), §8 migration/tabelas (Task 1), §9 janela/idempotência (Task 5/9), §10 payload/chunk (Task 6), §11 assinatura (Task 4), §12 entrega/retry (Task 7), §13 job (Task 9), §14 API (Task 8), §15 frontend (Task 10/11), §16 auditoria (Task 8), §17 testes (todas), §18 publicação (Task 12). ✅
- Sem placeholders; interfaces nomeadas e consistentes entre tasks.
- Ordem de execução: 1 → 2/3/4/5/6 (módulos puros, paralelizáveis conceitualmente mas executados em sequência) → 7 → 8 → 9 → 10 → 11 → 12.
