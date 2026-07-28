# Etapa B — Hardening da entrega (revisão do PR #15)

Correções bloqueantes pedidas na revisão do PR #15. Branch `feat/integracao-webhook-lote`, **sem merge**.
Não habilitar integrações externas; não configurar cron; não tocar produção/n8n/QuePasa.

## Contrato do transporte seguro (R1) — anti DNS-rebinding

`server/integrations/transport.js` expõe `secureDeliver({ url, method, headers, body, allowHttp, timeoutMs, maxRedirects, lookupImpl })` → `{ status, http_code, duration_ms, error?, finalUrl }`.

Invariante central: **a conexão TCP usa exatamente um IP previamente validado**, sem 2ª resolução DNS
não controlada. Passos por hop:
1. `assertSafeUrl(currentUrl, { allowHttp, resolver })` — resolve o hostname e valida **todos** os IPs
   (reusa `ssrf.js`: privadas IPv4, loopback, link-local, CGNAT, IPv4-mapped, metadata, IPv6 local). Se
   **qualquer** IP falhar → bloqueia tudo.
2. Escolhe **um** IP validado (`ips[0]`).
3. Conecta via `https.request`/`http.request` passando `lookup` customizado que **sempre retorna o IP
   validado** (o cliente HTTP não faz outra resolução). `servername` (SNI) = hostname original; header
   `Host` = hostname original; `rejectUnauthorized: true` (cert validado contra o hostname).
4. Redirects `manual` (não seguir automático): ao receber 3xx, resolve o `Location` (absoluto ou
   **relativo** ao currentUrl), repete os passos 1–3, **invalidando o IP anterior ao mudar de
   hostname**; limita a `maxRedirects` (3).
5. Sucesso só `200–299`.

Proibido: `rejectUnauthorized:false`; trocar hostname por IP sem SNI; `fetch` comum após validação
separada; cache de DNS indefinido entre entregas (cada entrega revalida).

`delivery.js` passa a usar `secureDeliver` no lugar de `fetch`+`assertSafeUrl` separados. `lookupImpl`
é injetável (testes simulam rebinding: 1ª resolução IP público, 2ª seria 127.0.0.1/metadata — provar
que a 2ª nunca ocorre e que a conexão usa só o IP validado).

**Testes R1:** rebinding simulado (transporte não faz 2ª resolução; usa só o IP validado); host com
múltiplos IPs contendo um privado → bloqueia; redirect público→domínio privado → bloqueia; redirect
relativo; SNI e Host = hostname original; cert inválido rejeitado (sem desabilitar TLS).

## Máquina de estados de entrega/retry (R2/R3/R4)

`integration_delivery_batches.status` ∈ `{ pending, blocked, delivering, pending_retry, delivered, failed }`.
- **pending** — criado com gate ON, aguardando 1ª tentativa neste/próximo ciclo.
- **blocked** — criado com gate OFF; não tenta (sem rajada). Vira elegível quando o gate liga.
- **delivering** — tentativa em andamento (guarda de concorrência).
- **pending_retry** — falhou, agendado p/ `next_attempt_at`, `attempt_count < max`.
- **delivered** — sucesso (terminal).
- **failed** — esgotou o máximo (terminal).

Campos novos (migration R2): `attempt_count INT UNSIGNED DEFAULT 0`, `next_attempt_at DATETIME NULL`,
`last_attempt_at DATETIME NULL`. Enum `status` estendido (defensivo).

**Backoff** (min): tentativa 1 imediata; após falha → 2, 6, 18, 54 min (via `next_attempt_at =
last_attempt_at + delay[attempt_count]`). Máx 5 tentativas → `failed`. Unidade em MINUTOS (justificada:
janela diária tolera atrasos; evita rajada). Config `deliveryConfig().backoffMinutes = [2,6,18,54]`.

Elegibilidade de entrega (por ciclo do job):
- gate ON: batches com `status IN (pending, pending_retry)` e (`next_attempt_at IS NULL` OU
  `next_attempt_at <= now`); **e** batches `blocked` (dentro do catchup) → tornam-se elegíveis.
- **uma tentativa por batch por ciclo** (sem rajada). Guarda: só processa se não estiver `delivering`
  (UPDATE condicional `status→delivering WHERE status IN (...) AND id=?` — linhas afetadas 0 = outro
  worker pegou → pula). Preserva idempotência (não recria batch; usa o mesmo `idempotency_key`).
- Sucesso → `delivered` (cancela retries). Falha retentável (timeout/rede/5xx) e `attempt_count<max` →
  `pending_retry` + agenda. `attempt_count>=max` → `failed`. Códigos não-retentáveis (se definidos:
  ex. SSRF_BLOCKED, 4xx exceto 408/429) → `failed` direto.
- gate OFF: batches `blocked` **não** consomem tentativas.

**Reenvio manual** (`POST /batches/:id/resend`): usa a mesma guarda de concorrência (`status→delivering`
condicional) — não colide com o retry automático; após, volta ao estado apropriado.

## Gate off + avanço de janela + catchup (R4)

- Com gate OFF: o job **cria** o batch da janela como `blocked` e **avança** `last_run_window_end`
  (não recria). Ao ligar o gate, o job entrega os `blocked` pendentes (dentro do catchup) — **sem exigir
  reenvio manual**.
- Retenção: `INTEGRATIONS_MAX_CATCHUP_DAYS` (default 7). Na criação de janelas, não backfilla além de N
  dias; batches `blocked` mais antigos que N dias não são entregues automaticamente (log + ficam como
  histórico, ou marcados `failed` por retenção — documentar; escolha: não entregar, manter `blocked`).
- Documentar explicitamente este comportamento (docs + PR).

## Logs sanitizados (R4)

No job, nunca `console.error(..., e.message)` cru. Mapear exceções (banco, cripto, URL parse, HTTP,
config) para **códigos fechados** antes de logar. Log só: `tenantId, integrationId, batchId,
código sanitizado, contagens, duração`. Nada de secret/URL completa/credencial/corpo.

## Migration (R2)

`migrations/20260801140000_integration_retry_fields.cjs` — defensiva/reversível: adiciona os 3 campos
se ausentes; estende o enum `status` (valida enum atual, adiciona `blocked`/`pending_retry` se
faltarem; erro explícito se incompatível). `down` reverte. **Só banco de teste**; 0 pendências.

## Validação final (R5)

`npm test` + `npm run build`; validações: rebinding simulado; conexão presa ao IP validado + SNI;
redirect privado bloqueado; retry antes do vencimento não executa; retry após vencimento executa;
sucesso encerra; gate off sem rajada; habilitação posterior processa `blocked`; concorrência não
duplica; logs sem segredo/URL/conteúdo. Atualizar docs + corpo do PR; commit+push; PR #15 **aberto,
sem merge**.
