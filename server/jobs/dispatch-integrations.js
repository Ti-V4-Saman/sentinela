#!/usr/bin/env node
// Job de despacho idempotente das integrações por webhook em lote (Etapa B).
//
// Cron recomendado (NÃO configurado por este arquivo — nenhum agendamento é tocado aqui):
//   */15 * * * *  cd <repo> && npm run integrations:dispatch >> logs/integrations-dispatch.log 2>&1
// Rodar a cada 15 min é seguro: `computeDueWindow` só retorna trabalho quando a janela do dia
// local venceu E ainda não foi processada (`last_run_window_end`), então execuções extras dentro
// da mesma janela são no-ops baratos (uma query por integração ativa).
//
// Comportamento (ver docs/superpowers/plans/2026-07-28-integracao-webhook-lote.md, Task 9):
//  1. Lock anti-concorrência via GET_LOCK do MySQL — evita 2 execuções simultâneas do job (ex.:
//     cron sobreposto por uma execução lenta anterior). Se não conseguir o lock, sai já (exit 0).
//  2. Varre TODAS as integrações ativas (todos os tenants) com `listActiveIntegrations`. Cada
//     integração é processada num try/catch PRÓPRIO — uma config quebrada (ex.: run_at_time
//     inválido, que faz `computeDueWindow` lançar) NUNCA aborta as demais.
//  3. Para cada integração com janela vencida: lê os dados (read-only), monta o payload, faz o
//     chunking, cria o(s) batch(es) de forma idempotente (`createBatch`) e, se o gate global
//     `EXTERNAL_INTEGRATIONS_ENABLED` estiver ligado, tenta entregar (`runWithRetries`).
//  4. `last_run_window_end` é atualizado assim que o(s) batch(es) da janela existem — ANTES/
//     independente do resultado da entrega. Decisão documentada: criar o batch já é "a janela foi
//     processada" (não pode haver 2 batches para a mesma janela); reenvios de falha de entrega são
//     tratados por reenvio manual (Task 8), não por recriar o batch numa próxima execução do job.
//     Isso vale mesmo com o gate OFF: a janela é registrada (batch criado, sem entrega), e a
//     próxima execução do job não deve tentar criar o mesmo batch de novo.
//  5. Exit code: 0 quando não há trabalho, quando tudo processou sem falha de entrega, OU quando o
//     único motivo de "não sucesso" foi o gate global desligado (não é uma falha operacional, é
//     comportamento esperado do ambiente). Não-zero quando: (a) alguma tentativa de entrega
//     terminou em falha (HTTP fora de 200–299, timeout, rede, SSRF, redirect bloqueado etc.), OU
//     (b) alguma config lançou exceção ao processar (algo precisa de atenção humana) — mesmo
//     tendo sido isolada e não ter derrubado o job, ela deve acender alerta no cron/monitoramento.
//  6. Logs: nunca secret, URL crua ou corpo de resposta — só linhas estruturadas curtas com
//     tenantId/integrationId/contadores/códigos de erro sanitizados (os mesmos que `delivery.js`
//     já produz).

import { computeDueWindow, idempotencyKey } from '../integrations/window.js';
import { buildPayload, chunkPayload } from '../integrations/payload.js';
import { runWithRetries } from '../integrations/delivery.js';
import { isProdLike, integrationsSecretKey } from '../integrations/config.js';
import {
  listActiveIntegrations, loadWindowData, createBatch, recordAttempt, setBatchStatus,
  updateLastRunWindowEnd, getSigningSecret,
} from '../integrations/repo.js';
import { writeAudit } from '../audit.js';

const LOCK_NAME = 'sentinela_integrations_dispatch';
const SCHEMA_VERSION = 1;

// Adquire o lock numa conexão DEDICADA (não pode ser uma conexão que volta pro pool no meio do
// job — GET_LOCK é por sessão; se a conexão fosse liberada de volta ao pool e reaproveitada por
// outra operação, o lock ficaria "solto" no meio do processamento). Segue o mesmo padrão de
// `server/tx.js`: se `lockPool` não tem `getConnection` (harness de teste injeta uma conexão
// única já em transação), usamos essa própria conexão como "sessão" do lock.
async function acquireLock(lockPool) {
  const hasPool = typeof lockPool.getConnection === 'function';
  const conn = hasPool ? await lockPool.getConnection() : lockPool;
  const [[row]] = await conn.query('SELECT GET_LOCK(?, 0) AS got', [LOCK_NAME]);
  const got = Number(row.got) === 1;
  return {
    got,
    async release() {
      try {
        await conn.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
      } catch (e) {
        console.error('dispatch: falha ao liberar lock (sanitizado):', e.message);
      } finally {
        if (hasPool) conn.release();
      }
    },
  };
}

function sanitizedLog(event, fields = {}) {
  const parts = Object.entries(fields)
    .map(([k, v]) => `${k}=${v === null || v === undefined ? '-' : v}`)
    .join(' ');
  console.log(`dispatch: ${event}${parts ? ' ' + parts : ''}`);
}

// Processa UMA integração: computa a janela, lê dados, monta+chunka o payload, cria batch(es)
// idempotentes e tenta entregar (se o gate estiver ligado). Nunca lança — qualquer erro inesperado
// é responsabilidade do chamador (que envolve esta função inteira em try/catch por integração).
async function processIntegration({ pool, cfg, now, fetchImpl, allowHttp, maxAttempts, secretKey }) {
  const window = computeDueWindow(cfg, now);
  if (!window) {
    return { processed: false, hadFailure: false };
  }

  // Decifra o secret UMA vez por integração (mesmo valor para todas as partes desta janela).
  // Se não houver secret configurado, a janela ainda é registrada como processada (mesmo
  // comportamento de quando o gate global está desligado) — só que a causa vai para o attempt
  // como `SECRET_NOT_SET` em vez de tentar assinar com um valor ausente.
  const secretPlaintext = await getSigningSecret(pool, cfg.tenant_id, secretKey);

  const { conversations, messages } = await loadWindowData(pool, cfg.tenant_id, cfg, window);
  const fullPayload = buildPayload({
    tenant: { id: cfg.tenant_id },
    integration: cfg,
    window,
    conversations,
    messages,
    schemaVersion: SCHEMA_VERSION,
  });
  const parts = chunkPayload(fullPayload, {});

  let hadFailure = false;

  for (const part of parts) {
    const key = idempotencyKey({
      tenantId: cfg.tenant_id,
      integrationId: cfg.id,
      windowStart: window.start,
      windowEnd: window.end,
      schemaVersion: SCHEMA_VERSION,
      part: part.batch.part,
    });

    const { id: batchId, created } = await createBatch(pool, {
      tenantId: cfg.tenant_id,
      integrationId: cfg.id,
      schemaVersion: SCHEMA_VERSION,
      windowStart: window.start,
      windowEnd: window.end,
      part: part.batch.part,
      partTotal: part.batch.part_total,
      idempotencyKey: key,
      conversationCount: part.conversations.length,
      messageCount: part.messages.length,
    });

    if (!created) {
      // Batch já existia (idempotência de janela/parte) — nunca reenvia aqui, independente do
      // status: se já foi 'delivered', reenviar duplicaria a entrega; se ficou 'pending'/'failed',
      // o reenvio é responsabilidade do fluxo manual (Task 8), não deste job.
      continue;
    }

    // Sem secret configurado: nunca tenta assinar/entregar com um valor ausente. Registra uma
    // falha sanitizada (SECRET_NOT_SET) e segue para a próxima parte/integração — não crasha o
    // job (mesmo tratamento de "não é uma exceção", só um estado operacional a corrigir).
    if (!secretPlaintext) {
      // eslint-disable-next-line no-await-in-loop
      await recordAttempt(pool, {
        tenantId: cfg.tenant_id, batchId, attemptNo: 1, status: 'failure',
        httpCode: null, durationMs: null, error: 'SECRET_NOT_SET',
      });
      // eslint-disable-next-line no-await-in-loop
      await writeAudit(pool, {
        tenantId: cfg.tenant_id, action: 'deliver_integration', resource: 'integration_batch',
        resourceId: batchId, status: 'fail', metadata: { httpCode: null },
      });
      // eslint-disable-next-line no-await-in-loop
      await setBatchStatus(pool, cfg.tenant_id, batchId, 'failed');
      hadFailure = true;
      sanitizedLog('delivery_attempt', {
        tenantId: cfg.tenant_id, integrationId: cfg.id, batchId, status: 'failure',
        httpCode: '-', error: 'SECRET_NOT_SET',
      });
      continue;
    }

    // Gate desligado: `runWithRetries`/`deliverBatch` já tratam isso — NÃO chamam fetchImpl e
    // gravam failure `EXTERNAL_INTEGRATIONS_DISABLED` (nunca um sucesso falso). Reaproveitamos o
    // mesmo caminho abaixo em vez de duplicar a decisão aqui.
    const rawBody = JSON.stringify(part);
    const timestamp = String(Math.floor(now.getTime() / 1000));
    const deliveryId = `dispatch-${batchId}-${timestamp}`;

    // eslint-disable-next-line no-await-in-loop
    const result = await runWithRetries({
      integration: cfg,
      secretPlaintext,
      batchRow: { schema_version: SCHEMA_VERSION },
      rawBody,
      timestamp,
      deliveryId,
      idempotencyKey: key,
      fetchImpl,
      allowHttp,
      maxAttempts,
      recordAttempt: async ({ attemptNo, status, http_code: httpCode, duration_ms: durationMs, error }) => {
        await recordAttempt(pool, {
          tenantId: cfg.tenant_id, batchId, attemptNo, status, httpCode, durationMs, error: error || null,
        });
        await writeAudit(pool, {
          tenantId: cfg.tenant_id, action: 'deliver_integration', resource: 'integration_batch',
          resourceId: batchId, status: status === 'success' ? 'ok' : 'fail',
          metadata: { httpCode: httpCode ?? null },
        });
      },
    });

    const finalStatus = result.status === 'success' ? 'delivered' : 'failed';
    await setBatchStatus(pool, cfg.tenant_id, batchId, finalStatus);

    // Gate desligado não conta como falha operacional do job (comportamento esperado).
    if (result.status !== 'success' && result.error !== 'EXTERNAL_INTEGRATIONS_DISABLED') {
      hadFailure = true;
    }

    sanitizedLog('delivery_attempt', {
      tenantId: cfg.tenant_id, integrationId: cfg.id, batchId, status: result.status,
      httpCode: result.http_code ?? '-', error: result.error ?? '-',
    });
  }

  // Marca a janela como processada assim que os batches existem — mesmo com o gate desligado ou
  // com falha de entrega (reenvio de falha é fluxo manual, não recriação de batch).
  await updateLastRunWindowEnd(pool, cfg.tenant_id, cfg.id, window.end);

  await writeAudit(pool, {
    tenantId: cfg.tenant_id, action: 'run_integration_batch', resource: 'integration',
    resourceId: cfg.id, status: hadFailure ? 'fail' : 'ok',
    metadata: { parts: parts.length, windowEnd: window.end.toISOString() },
  });

  return { processed: true, hadFailure };
}

// Ponto de entrada testável. `pool` pode ser um pool mysql2 real (produção) ou uma conexão única
// já em transação (harness de teste `withTx`). `lockPool` (opcional) é usado só para a checagem
// de lock — nos testes de concorrência precisa ser o pool real (compartilhado com quem já
// segura o lock em outra conexão); por padrão é o mesmo `pool`.
export async function runDispatch({
  pool, now, fetchImpl, allowHttp = false, lockPool = pool, maxAttempts, secretKey,
}) {
  const lock = await acquireLock(lockPool);
  if (!lock.got) {
    sanitizedLog('another dispatch is running, skipping');
    return { exitCode: 0, skipped: true, processed: 0, failures: 0, errors: 0 };
  }

  try {
    const integrations = await listActiveIntegrations(pool);
    let processed = 0;
    let failures = 0;
    let errors = 0;

    for (const cfg of integrations) {
      try {
        // `integrationsSecretKey()` é lida por integração (dentro do try) — se ausente/inválida,
        // essa integração é isolada como erro (mesmo tratamento de config quebrada), sem
        // derrubar as demais nem exigir a env var em cenários sem integrações ativas.
        const key = secretKey ?? integrationsSecretKey();
        // eslint-disable-next-line no-await-in-loop
        const result = await processIntegration({
          pool, cfg, now, fetchImpl, allowHttp, maxAttempts, secretKey: key,
        });
        if (result.processed) {
          processed += 1;
          if (result.hadFailure) failures += 1;
        }
      } catch (e) {
        errors += 1;
        console.error(
          `dispatch: falha ao processar integração (sanitizado) tenantId=${cfg.tenant_id} integrationId=${cfg.id}:`,
          e.message,
        );
      }
    }

    const exitCode = (failures > 0 || errors > 0) ? 1 : 0;
    sanitizedLog('done', { integrations: integrations.length, processed, failures, errors, exitCode });
    return { exitCode, skipped: false, processed, failures, errors };
  } finally {
    await lock.release();
  }
}

// ---- CLI entry point ----
async function main() {
  const { default: pool } = await import('../db.js');
  const result = await runDispatch({
    pool,
    now: new Date(),
    fetchImpl: fetch,
    allowHttp: !isProdLike(),
  });
  await pool.end();
  process.exit(result.exitCode);
}

// Só roda o CLI quando este arquivo é executado diretamente (node server/jobs/dispatch-integrations.js),
// nunca quando importado por testes.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((e) => {
    console.error('dispatch: erro fatal (sanitizado):', e.message);
    process.exit(1);
  });
}
