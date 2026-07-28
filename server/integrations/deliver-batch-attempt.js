// Helper de UMA tentativa de entrega para um batch já reivindicado (status 'delivering') — usado
// tanto pelo JOB (server/jobs/dispatch-integrations.js, ciclo automático) quanto pela rota de
// reenvio manual (server/routes/integrations.js, POST /batches/:id/resend) para NUNCA divergir a
// lógica de reconstrução de payload + entrega + classificação retryable/non-retryable + transição
// de estado entre os dois caminhos (ver docs/superpowers/plans/2026-07-28-etapaB-hardening.md,
// seção "Máquina de estados de entrega/retry").
//
// Pré-condição: o CHAMADOR já reivindicou o batch (claimBatchForAttempt) — este módulo não
// reivindica nada, só executa a tentativa e grava o resultado (attempt + transição de status).
//
// Classificação retryable vs non-retryable (documentada aqui pois é usada nos dois pontos de
// chamada):
// - RETRYÁVEL (agenda via scheduleRetry): TIMEOUT, NETWORK, HTTP_5xx, HTTP_408, HTTP_429 — falhas
//   plausivelmente transitórias (rede instável, sobrecarga momentânea do receptor).
// - NÃO-RETRYÁVEL (falha direta, sem consumir o orçamento de retries): SSRF_BLOCKED:*,
//   REDIRECT_BLOCKED, TOO_MANY_REDIRECTS, HTTP_4xx exceto 408/429 (ex.: 400/401/403/404/422) —
//   sinaliza um problema permanente de configuração (URL bloqueada por SSRF, endpoint inexistente,
//   payload rejeitado) que uma nova tentativa idêntica não resolve; insistir só atrasa o
//   diagnóstico e desperdiça o orçamento de tentativas.
// - SECRET_NOT_SET (secret do tenant ausente/não configurado) é tratado como retryable: é um
//   problema operacional que PODE ser corrigido a qualquer momento (o tenant configura o secret na
//   UI) sem exigir reenvio manual — melhor deixar o retry natural do job redescobrir o secret já
//   configurado do que exigir uma ação manual adicional. Esgotado o maxAttempts, vira `failed`
//   normalmente e fica visível para o operador investigar.

import { getSigningSecret, loadWindowData, recordAttempt, markDelivered, scheduleRetry } from './repo.js';
import { buildPayload, chunkPayload } from './payload.js';
import { deliverBatch } from './delivery.js';
import { deliveryConfig } from './config.js';
import { writeAudit } from '../audit.js';

const RETRYABLE_CODES = new Set(['TIMEOUT', 'NETWORK', 'SECRET_NOT_SET']);

function isRetryable(error, httpCode) {
  if (httpCode != null) {
    if (httpCode >= 500 && httpCode <= 599) return true;
    if (httpCode === 408 || httpCode === 429) return true;
    return false; // demais 4xx: não-retryável
  }
  if (!error) return true; // sucesso não chega aqui; ausência de código com falha é tratada como rede
  if (error.startsWith('SSRF_BLOCKED') || error === 'REDIRECT_BLOCKED' || error === 'TOO_MANY_REDIRECTS') {
    return false;
  }
  return RETRYABLE_CODES.has(error);
}

// Reconstrói o payload exato da parte deste batch a partir da janela persistida (nunca recalcula a
// janela — usa window_start/window_end/part já gravados no batch, igual a `manualResendWindow`).
async function rebuildPartPayload(pool, { tenantId, integration, batch }) {
  const window = { start: batch.window_start, end: batch.window_end };
  const { conversations, messages } = await loadWindowData(pool, tenantId, integration, window);
  const fullPayload = buildPayload({
    tenant: { id: tenantId },
    integration,
    window,
    conversations,
    messages,
    schemaVersion: batch.schema_version,
  });
  const parts = chunkPayload(fullPayload, {});
  return parts.find((p) => p.batch.part === batch.part) || parts[0];
}

// Executa UMA tentativa de entrega para um batch já em `delivering`. Nunca lança — qualquer
// exceção interna (DB/crypto/URL/HTTP) é responsabilidade do CHAMADOR sanitizar/logar; aqui
// devolvemos sempre um resultado estruturado.
//
// `auditAction`: 'deliver_integration' (job) ou 'resend_integration_batch' (reenvio manual) — o
// mesmo helper audita com a ação correta pedida pelo chamador.
//
// Retorna { attemptStatus: 'delivered'|'pending_retry'|'failed', httpCode, error, durationMs }.
export async function attemptBatchDelivery(pool, {
  tenantId, integration, batch, now, secretKey, allowHttp, fetchImpl, lookupImpl,
  deliveryIdPrefix, auditAction, maxAttempts, backoffMinutes,
}) {
  const cfg = deliveryConfig();
  const effectiveMaxAttempts = maxAttempts ?? cfg.maxAttempts;
  const effectiveBackoff = backoffMinutes ?? cfg.backoffMinutes;
  const attemptNo = batch.attempt_count + 1;

  const secretPlaintext = await getSigningSecret(pool, tenantId, secretKey);

  let result;
  if (!secretPlaintext) {
    result = { status: 'failure', http_code: null, duration_ms: 0, error: 'SECRET_NOT_SET' };
  } else {
    const part = await rebuildPartPayload(pool, { tenantId, integration, batch });
    const rawBody = JSON.stringify(part);
    const timestamp = String(Math.floor(now.getTime() / 1000));
    const deliveryId = `${deliveryIdPrefix}-${batch.id}-${timestamp}`;

    result = await deliverBatch({
      integration,
      secretPlaintext,
      batchRow: batch,
      rawBody,
      timestamp,
      deliveryId,
      idempotencyKey: batch.idempotency_key,
      fetchImpl,
      allowHttp,
      lookupImpl,
    });
  }

  await recordAttempt(pool, {
    tenantId, batchId: batch.id, attemptNo, status: result.status,
    httpCode: result.http_code ?? null, durationMs: result.duration_ms ?? null,
    error: result.error || null,
  });
  await writeAudit(pool, {
    tenantId, action: auditAction, resource: 'integration_batch', resourceId: batch.id,
    status: result.status === 'success' ? 'ok' : 'fail',
    metadata: { httpCode: result.http_code ?? null },
  });

  if (result.status === 'success') {
    await markDelivered(pool, batch.id, { now });
    return {
      attemptStatus: 'delivered', httpCode: result.http_code, error: null, durationMs: result.duration_ms,
    };
  }

  const retryable = isRetryable(result.error, result.http_code);
  if (retryable) {
    const scheduled = await scheduleRetry(pool, batch.id, {
      attemptCount: attemptNo, now, backoffMinutes: effectiveBackoff, maxAttempts: effectiveMaxAttempts,
    });
    return {
      attemptStatus: scheduled.status, httpCode: result.http_code, error: result.error,
      durationMs: result.duration_ms,
    };
  }

  // Não-retryável: falha direta, sem consumir/agendar retry — problema permanente (URL/config).
  await pool.query(
    `UPDATE integration_delivery_batches
       SET status = 'failed', attempt_count = ?, next_attempt_at = NULL, updated_at = NOW()
     WHERE id = ?`,
    [attemptNo, batch.id],
  );
  return {
    attemptStatus: 'failed', httpCode: result.http_code, error: result.error, durationMs: result.duration_ms,
  };
}

export const _internal = { isRetryable, rebuildPartPayload };
