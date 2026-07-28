# Integrações por webhook em lote

Referência operacional da integração de exportação em lote (Configurações > Integrações).
Para o desenho completo de implementação, ver `docs/superpowers/plans/2026-07-28-integracao-webhook-lote.md`
e o round de hardening em `docs/superpowers/plans/2026-07-28-etapaB-hardening.md`.

## Visão geral

Cada tenant pode configurar, opcionalmente, uma exportação diária em lote das conversas monitoradas
para uma URL externa. O lote é assinado por HMAC, entregue de forma idempotente e **desligada por
padrão** no ambiente — nada é enviado até o operador ligar o gate explicitamente.

## Variáveis de ambiente

| Variável | Default | Descrição |
|---|---|---|
| `EXTERNAL_INTEGRATIONS_ENABLED` | `false` | Gate global de envio real. Só a string exata `'true'` liga; qualquer outro valor (ausente, `'1'`, `'TRUE'` etc.) é tratado como desligado (fail-closed). Com o gate off, **nenhum POST externo ocorre** — nem pelo job, nem por reenvio manual — e nenhuma tentativa aparece como sucesso falso. |
| `INTEGRATIONS_SECRET_KEY` | — (obrigatória para assinar) | Chave AES-256-GCM de 32 bytes (64 hex ou base64) usada para cifrar o secret HMAC de cada integração em repouso. O secret de cada tenant é decifrado só em memória, no momento de assinar uma entrega — nunca fica em texto plano persistido. |
| `INTEGRATIONS_MAX_CATCHUP_DAYS` | `7` | Quantos dias no passado o job ainda entrega automaticamente batches criados como `blocked` (ver [Gate desligado + catchup](#gate-desligado--avanço-de-janela--catchup)) quando o gate é ligado. |

## Transporte seguro (anti DNS-rebinding)

A entrega HTTP é feita por um transporte próprio (`server/integrations/transport.js`), não por um
`fetch` genérico. A conexão TCP fica **presa a um único IP previamente validado**, sem segunda
resolução DNS não controlada:

1. O hostname é resolvido e **todos** os IPs retornados são validados contra a defesa SSRF (bloqueia
   loopback, faixas privadas IPv4, link-local, CGNAT, IPv4-mapped, endpoint de metadata de nuvem e
   faixas locais/privadas IPv6). Se qualquer IP falhar, a entrega inteira é bloqueada.
2. Um dos IPs validados é escolhido e a conexão HTTP(S) usa um resolver customizado que **sempre
   retorna esse mesmo IP** — o cliente HTTP nunca faz uma segunda resolução.
3. SNI e header `Host` continuam sendo o hostname original; o certificado TLS é validado
   normalmente contra esse hostname (`rejectUnauthorized` nunca é desabilitado).
4. Redirects são seguidos manualmente (não automático pelo cliente HTTP): a cada 3xx, o destino é
   revalidado do zero (passos 1–3), invalidando o IP anterior; limite de 3 redirects.
5. Sucesso só é considerado para HTTP 200–299.

Com esse desenho, **é correto afirmar proteção contra DNS rebinding**: o transporte permanece preso
ao IP validado durante toda a entrega (inclusive em cada hop de redirect), então uma reresolução
maliciosa do DNS entre a validação e a conexão não tem efeito.

## Assinatura

Cada entrega é assinada com `HMAC-SHA256(secret, "${timestamp}.${rawBody}")`, enviado em hex no
header `X-Sentinela-Signature` (formato `sha256=<hex>`). Headers enviados em toda entrega:

- `X-Sentinela-Signature`
- `X-Sentinela-Timestamp`
- `X-Sentinela-Delivery`
- `X-Sentinela-Schema-Version`
- `Idempotency-Key`

**Como o receptor deve validar:** recomputar o HMAC sobre `"${timestamp}.${rawBody}"` usando o
secret em texto plano (mostrado uma única vez na UI ao gerar/regenerar), comparar com
`X-Sentinela-Signature` de forma timing-safe, e rejeitar timestamps fora de uma janela de tolerância
razoável (proteção contra replay).

## Máquina de estados e retry

`integration_delivery_batches.status` percorre:

`pending` → `delivering` → `delivered` (sucesso, terminal)
`pending` → `delivering` → `pending_retry` → `delivering` → ... → `failed` (esgotou tentativas, terminal)
`blocked` (criado com o gate desligado; vira elegível quando o gate liga)

- **Backoff:** 2, 6, 18, 54 minutos entre tentativas; máximo de 5 tentativas — esgotado o limite, o
  batch vai para `failed`.
- **Uma tentativa por batch por ciclo do job** (sem rajada de retries).
- **Guarda de concorrência:** a transição para `delivering` é uma atualização condicional
  (`status → delivering WHERE status IN (...) AND id = ?`); se nenhuma linha for afetada, outro
  worker/execução já pegou o batch e este ciclo simplesmente pula — evita tentativa dupla.
- `delivered` e `failed` são estados terminais (não são reprocessados pelo job).

**Códigos retryáveis** (agendam retry via backoff): `TIMEOUT`, `NETWORK`, HTTP 5xx, HTTP 408, HTTP
429, `SECRET_NOT_SET` (o tenant pode configurar o secret a qualquer momento; melhor deixar o retry
natural redescobrir do que exigir reenvio manual).

**Códigos não-retryáveis** (falha direta, sem consumir orçamento de retry — vão para `failed`
imediatamente): `SSRF_BLOCKED:*`, `REDIRECT_BLOCKED`, `TOO_MANY_REDIRECTS`, HTTP 4xx exceto 408/429
(ex.: 400/401/403/404/422) — sinalizam um problema permanente de configuração que uma nova tentativa
idêntica não resolve.

> **Nota sobre o horário do retry:** `next_attempt_at` é calculado a partir de `now` no momento em
> que o agendamento é feito (aproximadamente `last_attempt_at` + duração da tentativa, que tem teto
> de 15s pelo timeout de entrega). Na granularidade de minutos usada pelo backoff, essa diferença é
> desprezível.

## Gate desligado + avanço de janela + catchup

Com o gate `EXTERNAL_INTEGRATIONS_ENABLED` desligado, o job **continua** criando o batch da janela
diária normalmente, mas como `blocked` — e avança `last_run_window_end` (não recria o batch em
execuções seguintes; preserva idempotência).

Quando o gate é ligado, o job passa a entregar automaticamente os batches `blocked` que estejam
dentro de `INTEGRATIONS_MAX_CATCHUP_DAYS` dias — **sem exigir reenvio manual**. Batches `blocked`
mais antigos que esse limite não são entregues automaticamente; ficam como histórico (nunca são
forçados para `failed` só por retenção de catchup).

## Logs sanitizados

Toda exceção (banco, criptografia, parsing de URL, configuração, rede, timeout) é mapeada para um
código fechado antes de ser logada: `DB_ERROR`, `CRYPTO_ERROR`, `URL_ERROR`, `CONFIG_ERROR`,
`NETWORK`, `TIMEOUT`, `UNKNOWN`. Os logs registram apenas `tenantId`, `integrationId`, `batchId`,
o código sanitizado, contagens e duração — **nunca** o secret, a URL completa ou o corpo da
requisição/resposta.

## Job / cron

Comando: `npm run integrations:dispatch`.

- Idempotente: usa `GET_LOCK` do MySQL para impedir execuções concorrentes do job.
- Exit code reflete o resultado (sucesso/sem trabalho vs. falha de entrega).
- Cron recomendado: a cada 15 minutos — a checagem de janela vencida e o agendamento por backoff
  tornam reexecuções frequentes seguras (não há rajada nem duplicação).
- **O cron do servidor não é configurado por este projeto.** Precisa ser agendado manualmente pelo
  operador quando desejar habilitar a integração em produção.

## Segurança / operação

Para habilitar envios reais:

1. Definir `EXTERNAL_INTEGRATIONS_ENABLED=true` e `INTEGRATIONS_SECRET_KEY` no ambiente-alvo.
2. Agendar o cron do job (`npm run integrations:dispatch`) manualmente — não é feito automaticamente.

Enquanto o gate estiver desligado, nada é enviado para fora do ambiente — configuração, geração de
secret e testes de UI continuam disponíveis, mas sem POST externo real.
