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
// - PAYLOAD_INTEGRITY (snapshot ausente/corrompido/adulterado no banco) é NÃO-RETRYABLE e nunca
//   passa por `scheduleRetry`: diferente de SECRET_NOT_SET, um snapshot ausente/adulterado não se
//   corrige sozinho com o tempo — insistir só reagendaria uma falha idêntica indefinidamente. O
//   batch vai direto para `failed` (terminal), visível para investigação/recriação manual.
//
// Rotação de secret (Etapa B, S3 — ver docs/superpowers/plans/2026-07-28-etapaB-payload-snapshot.md,
// regra 5): cada tentativa (1ª, retry automático, reenvio manual) usa o secret CORRENTE do tenant
// no momento em que RODA (`getSigningSecret`, decifrado sob demanda a cada chamada — nunca
// cacheado). Se o secret for rotacionado entre tentativas, a tentativa seguinte assina com o novo
// secret; o receptor deve validar com o secret vigente na UI (o anterior é invalidado pela
// rotação). O payload (bytes exatos) e a `idempotency_key` permanecem imutáveis — só a ASSINATURA
// muda de secret; nenhum plaintext de secret é persistido no batch (só cifrado, no
// `tenant_integrations`, via `getSigningSecret`/`rotateSecret` em repo.js).

import {
  getSigningSecret, loadBatchSnapshot, recordAttempt, markDelivered, scheduleRetry,
} from './repo.js';
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

  // Etapa B, S3 — NUNCA reconstrói o payload: carrega o snapshot EXATO persistido na criação do
  // batch (ver docs/superpowers/plans/2026-07-28-etapaB-payload-snapshot.md, regra 3). Se o
  // snapshot estiver ausente (batch pré-existente sem snapshot) ou adulterado no banco,
  // `loadBatchSnapshot` lança PAYLOAD_INTEGRITY — tratado abaixo como falha NÃO-RETRYABLE direta
  // (nunca envia um corpo reconstruído/vazio, nunca agenda retry para um problema que não se
  // autocorrige).
  let snap;
  try {
    snap = await loadBatchSnapshot(pool, batch.id);
  } catch (e) {
    if (e && e.message === 'PAYLOAD_INTEGRITY') {
      return failNonRetryable(pool, {
        tenantId, batch, attemptNo, auditAction, error: 'PAYLOAD_INTEGRITY',
      });
    }
    throw e;
  }

  // Secret CORRENTE do tenant (rotação — ver comentário no topo do arquivo): decifrado sob
  // demanda a cada tentativa, nunca cacheado entre tentativas.
  const secretPlaintext = await getSigningSecret(pool, tenantId, secretKey);

  let result;
  if (!secretPlaintext) {
    result = { status: 'failure', http_code: null, duration_ms: 0, error: 'SECRET_NOT_SET' };
  } else {
    const rawBody = snap.rawBody;
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
      targetUrl: snap.targetUrl,
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

// Registra uma tentativa de falha NÃO-RETRYABLE que nunca chegou a tentar rede (hoje só
// PAYLOAD_INTEGRITY — snapshot ausente/adulterado): grava o attempt + audita + transiciona o
// batch direto para `failed` (terminal), sem passar por `scheduleRetry`. Mesma disciplina de
// erro sanitizado das demais falhas (nunca corpo/URL/secret no `error` gravado).
async function failNonRetryable(pool, {
  tenantId, batch, attemptNo, auditAction, error,
}) {
  await recordAttempt(pool, {
    tenantId, batchId: batch.id, attemptNo, status: 'failure',
    httpCode: null, durationMs: null, error,
  });
  await writeAudit(pool, {
    tenantId, action: auditAction, resource: 'integration_batch', resourceId: batch.id,
    status: 'fail', metadata: { httpCode: null },
  });
  await pool.query(
    `UPDATE integration_delivery_batches
       SET status = 'failed', attempt_count = ?, next_attempt_at = NULL, updated_at = NOW()
     WHERE id = ?`,
    [attemptNo, batch.id],
  );
  return {
    attemptStatus: 'failed', httpCode: null, error, durationMs: null,
  };
}

export const _internal = { isRetryable };
