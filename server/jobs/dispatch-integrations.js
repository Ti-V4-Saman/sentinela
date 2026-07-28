#!/usr/bin/env node
// Job de despacho idempotente das integrações por webhook em lote (Etapa B — hardening R4).
//
// Cron recomendado (NÃO configurado por este arquivo — nenhum agendamento é tocado aqui):
//   */15 * * * *  cd <repo> && npm run integrations:dispatch >> logs/integrations-dispatch.log 2>&1
// Rodar a cada 15 min é seguro: `computeDueWindow` só retorna trabalho quando a janela do dia
// local venceu E ainda não foi processada (`last_run_window_end`); a fase de entrega só processa
// batches com `next_attempt_at` vencido — execuções extras são no-ops baratos.
//
// DUAS FASES dentro do MESMO lock (GET_LOCK do MySQL, evita 2 execuções simultâneas do job):
//
// FASE 1 — cria batches para as janelas vencidas de cada integração ativa. Cada integração roda
// num try/catch PRÓPRIO (config quebrada nunca aborta as demais). Catchup: janelas cujo
// `window_end` já esteja mais antigo que `integrationsMaxCatchupDays()` dias NÃO geram batch (não
// teria sentido entregar/backfillar dados tão antigos) — mesmo assim `last_run_window_end` avança
// past essa janela, para o job não tentar reprocessá-la para sempre (log `catchup_skipped`
// sanitizado). `initialStatus` do batch é `pending` com o gate ligado, `blocked` com o gate
// desligado — em ambos os casos `last_run_window_end` avança IMEDIATAMENTE após criar o(s)
// batch(es) (idempotência de janela: a próxima execução não recria).
//
// FASE 2 — entrega os batches devidos, MAS SÓ SE O GATE ESTIVER LIGADO. Gate desligado: a fase
// inteira é pulada (nenhuma tentativa, nenhum attempt gravado, batches `blocked`/`pending_retry`
// ficam congelados exatamente como estão — nunca uma rajada quando o gate for religado, porque
// cada batch ainda consome no máximo 1 tentativa por ciclo do job dali em diante). Gate ligado:
// `listDueBatches` traz os elegíveis (pending/pending_retry vencidos + blocked dentro do catchup);
// para CADA um, reivindica com `claimBatchForAttempt` (guarda de concorrência — se outra execução/
// reenvio manual já pegou o batch, `claimed:false` e pulamos) e faz UMA tentativa via o helper
// compartilhado `attemptBatchDelivery` (mesmo código usado pelo reenvio manual — evita divergência
// entre os dois caminhos).
//
// Exit code: 0 quando não há falha de entrega nem exceção de config; gate OFF sozinho NUNCA torna
// o exit code não-zero (é o comportamento esperado do ambiente, não uma falha operacional).
//
// Logs: NUNCA secret, URL crua ou corpo de resposta — só linhas estruturadas curtas com
// tenantId/integrationId/batchId/contadores/códigos sanitizados (`sanitizeError`, nunca `e.message`
// bruto, que poderia embutir URL/detalhe sensível).

import { computeDueWindow, idempotencyKey } from '../integrations/window.js';
import { buildPayload, chunkPayload } from '../integrations/payload.js';
import {
  externalIntegrationsEnabled, isProdLike, integrationsSecretKey, deliveryConfig,
  integrationsMaxCatchupDays, sanitizeError,
} from '../integrations/config.js';
import {
  listActiveIntegrations, loadWindowData, createBatch, updateLastRunWindowEnd,
  listDueBatches, claimBatchForAttempt, releaseClaim,
} from '../integrations/repo.js';
import { attemptBatchDelivery } from '../integrations/deliver-batch-attempt.js';
import { writeAudit } from '../audit.js';

const LOCK_NAME = 'sentinela_integrations_dispatch';
const SCHEMA_VERSION = 1;
const DEFAULT_DELIVERY_LIMIT = 200;

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
        sanitizedLog('lock_release_failed', { code: sanitizeError(e) });
      } finally {
        if (hasPool) conn.release();
      }
    },
  };
}

// `sanitizeError` mora em `../integrations/config.js` (compartilhado com as rotas — ver
// docs/superpowers/plans/2026-07-28-etapaB-hardening.md, seção "Logs sanitizados (R4)"). Reexporta
// aqui para não quebrar `import { sanitizeError } from '../jobs/dispatch-integrations.js'`
// pré-existente (testes/outros módulos que já importavam deste caminho).
export { sanitizeError };

function sanitizedLog(event, fields = {}) {
  const parts = Object.entries(fields)
    .map(([k, v]) => `${k}=${v === null || v === undefined ? '-' : v}`)
    .join(' ');
  console.log(`dispatch: ${event}${parts ? ' ' + parts : ''}`);
}

// ---- FASE 1 — cria (ou avança sem criar, em catchup) o(s) batch(es) da janela vencida de UMA
// integração. Nunca lança — qualquer erro inesperado é responsabilidade do chamador (envolve esta
// função inteira em try/catch por integração).
async function createDueBatches({ pool, cfg, now, gateOn, maxCatchupDays }) {
  const window = computeDueWindow(cfg, now);
  if (!window) {
    return { processed: false, partsCreated: 0 };
  }

  const catchupCutoff = new Date(now.getTime() - maxCatchupDays * 24 * 60 * 60 * 1000);
  if (window.end.getTime() < catchupCutoff.getTime()) {
    // Catchup: janela velha demais para valer a pena materializar/entregar. Escolha documentada
    // (ver docs do plano, seção "Gate off + avanço de janela + catchup"): NÃO cria batch nenhum
    // para esta janela — só avança `last_run_window_end` past ela, para o job não tentar
    // reprocessá-la para sempre. Não há histórico de um batch "pulado por catchup" na tabela de
    // batches (decisão simples, documentada) — o log sanitizado abaixo é o único rastro.
    await updateLastRunWindowEnd(pool, cfg.tenant_id, cfg.id, window.end);
    sanitizedLog('catchup_skipped', {
      tenantId: cfg.tenant_id, integrationId: cfg.id, windowEnd: window.end.toISOString(),
    });
    return { processed: true, partsCreated: 0 };
  }

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
  const initialStatus = gateOn ? 'pending' : 'blocked';

  let partsCreated = 0;
  for (const part of parts) {
    const key = idempotencyKey({
      tenantId: cfg.tenant_id,
      integrationId: cfg.id,
      windowStart: window.start,
      windowEnd: window.end,
      schemaVersion: SCHEMA_VERSION,
      part: part.batch.part,
    });

    // eslint-disable-next-line no-await-in-loop
    const { created } = await createBatch(pool, {
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
      initialStatus,
    });
    if (created) partsCreated += 1;
  }

  // Marca a janela como processada assim que os batches existem — mesmo com o gate desligado
  // (batch fica `blocked`, é entregue quando o gate ligar dentro do catchup).
  await updateLastRunWindowEnd(pool, cfg.tenant_id, cfg.id, window.end);

  await writeAudit(pool, {
    tenantId: cfg.tenant_id, action: 'run_integration_batch', resource: 'integration',
    resourceId: cfg.id, status: 'ok',
    metadata: { parts: parts.length, partsCreated, windowEnd: window.end.toISOString() },
  });

  return { processed: true, partsCreated };
}

// ---- FASE 2 — reivindica e entrega UM batch já elegível (listDueBatches já filtrou). Nunca
// lança para o chamador — erros de infra viram um resultado de falha sanitizado.
async function deliverDueBatch({
  pool, batchRow, now, allowHttp, secretKey, maxAttempts, backoffMinutes, fetchImpl, lookupImpl,
}) {
  const claim = await claimBatchForAttempt(pool, batchRow.id, { now, includeBlocked: true });
  if (!claim.claimed) {
    return { attempted: false };
  }

  const cfg = await pool.query(
    'SELECT * FROM tenant_integrations WHERE id = ? AND tenant_id = ? LIMIT 1',
    [batchRow.integration_id, batchRow.tenant_id],
  ).then(([rows]) => rows[0]);

  if (!cfg) {
    // Integração foi removida entre o enfileiramento do batch e este ciclo — devolve a
    // reivindicação sem contar como falha de entrega (não é um erro de rede/HTTP).
    await releaseClaim(pool, batchRow.id, { toStatus: batchRow.status });
    sanitizedLog('delivery_skipped_missing_config', {
      tenantId: batchRow.tenant_id, integrationId: batchRow.integration_id, batchId: batchRow.id,
    });
    return { attempted: false };
  }

  const result = await attemptBatchDelivery(pool, {
    tenantId: batchRow.tenant_id,
    integration: cfg,
    batch: batchRow,
    now,
    secretKey,
    allowHttp,
    fetchImpl,
    lookupImpl,
    deliveryIdPrefix: 'dispatch',
    auditAction: 'deliver_integration',
    maxAttempts,
    backoffMinutes,
  });

  sanitizedLog('delivery_attempt', {
    tenantId: batchRow.tenant_id, integrationId: batchRow.integration_id, batchId: batchRow.id,
    status: result.attemptStatus, httpCode: result.httpCode ?? '-', code: result.error ?? '-',
    durationMs: result.durationMs ?? '-',
  });

  return { attempted: true, failed: result.attemptStatus === 'failed' };
}

// Ponto de entrada testável. `pool` pode ser um pool mysql2 real (produção) ou uma conexão única
// já em transação (harness de teste `withTx`). `lockPool` (opcional) é usado só para a checagem
// de lock — nos testes de concorrência precisa ser o pool real.
export async function runDispatch({
  pool, now, allowHttp = false, lockPool = pool, maxAttempts, secretKey,
  backoffMinutes, deliveryLimit = DEFAULT_DELIVERY_LIMIT, fetchImpl, lookupImpl,
}) {
  const lock = await acquireLock(lockPool);
  if (!lock.got) {
    sanitizedLog('another dispatch is running, skipping');
    return { exitCode: 0, skipped: true, processed: 0, delivered: 0, failures: 0, errors: 0 };
  }

  try {
    const gateOn = externalIntegrationsEnabled();
    const cfg = deliveryConfig();
    const effectiveMaxAttempts = maxAttempts ?? cfg.maxAttempts;
    const effectiveBackoff = backoffMinutes ?? cfg.backoffMinutes;
    const maxCatchupDays = integrationsMaxCatchupDays();

    // ---- FASE 1 ----
    const integrations = await listActiveIntegrations(pool);
    let processed = 0;
    let errors = 0;

    for (const integrationCfg of integrations) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await createDueBatches({
          pool, cfg: integrationCfg, now, gateOn, maxCatchupDays,
        });
        if (result.processed) processed += 1;
      } catch (e) {
        errors += 1;
        sanitizedLog('phase1_error', {
          tenantId: integrationCfg.tenant_id, integrationId: integrationCfg.id, code: sanitizeError(e),
        });
      }
    }

    // ---- FASE 2 ----
    let delivered = 0;
    let failures = 0;

    if (!gateOn) {
      sanitizedLog('delivery_skipped_gate_off');
    } else {
      const key = secretKey ?? integrationsSecretKey();
      const dueBatches = await listDueBatches(pool, {
        now, gateOn: true, limit: deliveryLimit, maxCatchupDays,
      });

      for (const batchRow of dueBatches) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const outcome = await deliverDueBatch({
            pool, batchRow, now, allowHttp, secretKey: key,
            maxAttempts: effectiveMaxAttempts, backoffMinutes: effectiveBackoff, fetchImpl, lookupImpl,
          });
          if (outcome.attempted) {
            delivered += 1;
            if (outcome.failed) failures += 1;
          }
        } catch (e) {
          errors += 1;
          // Reivindicação pode ter ficado presa em 'delivering' se a exceção ocorreu depois do
          // claim — solta de volta para o status anterior conhecido (pending/pending_retry/
          // blocked) para não travar o batch indefinidamente; melhor esforço (não lança se falhar).
          try {
            // eslint-disable-next-line no-await-in-loop
            await releaseClaim(pool, batchRow.id, {
              toStatus: batchRow.status === 'blocked' ? 'blocked' : 'pending',
            });
          } catch { /* melhor esforço */ }
          sanitizedLog('phase2_error', {
            tenantId: batchRow.tenant_id, integrationId: batchRow.integration_id,
            batchId: batchRow.id, code: sanitizeError(e),
          });
        }
      }
    }

    const exitCode = (failures > 0 || errors > 0) ? 1 : 0;
    sanitizedLog('done', {
      integrations: integrations.length, processed, delivered, failures, errors, gateOn, exitCode,
    });
    return { exitCode, skipped: false, processed, delivered, failures, errors };
  } finally {
    await lock.release();
  }
}

// ---- CLI entry point ----
async function main() {
  const { default: pool } = await import('../db.js');
  // NÃO passa `fetchImpl`/`lookupImpl` aqui: produção deve sempre usar o transporte seguro
  // (secureDeliver, transport.js) preso ao IP validado (anti DNS-rebinding). Esses seams só
  // existem para os testes injetarem um mock determinístico.
  const result = await runDispatch({
    pool,
    now: new Date(),
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
    sanitizedLog('fatal_error', { code: sanitizeError(e) });
    process.exit(1);
  });
}
