// Entrega HTTP do batch (Etapa B — integração em lote): gate global, defesa SSRF a cada entrega
// (incluindo redirects manuais), timeout, sucesso só 200–299, erro sempre sanitizado.
//
// Nunca segue redirect automaticamente (fetch é chamado com `redirect: 'manual'`): cada hop de
// redirect é validado por `checkRedirectTarget` (SSRF) ANTES de ser seguido — delegar isso ao
// cliente HTTP reabriria o vetor SSRF que `ssrf.js` fecha.
//
// Erros são reduzidos a códigos curtos e sanitizados (nunca secret, nunca URL crua, nunca corpo de
// resposta): `EXTERNAL_INTEGRATIONS_DISABLED`, `SSRF_BLOCKED:<reason>`, `REDIRECT_BLOCKED`,
// `TOO_MANY_REDIRECTS`, `TIMEOUT`, `NETWORK`, `HTTP_<code>`.

import { assertSafeUrl, checkRedirectTarget, MAX_REDIRECTS } from './ssrf.js';
import { buildHeaders } from './signature.js';
import { externalIntegrationsEnabled, deliveryConfig } from './config.js';

// Executa uma única tentativa de entrega. Nunca lança: qualquer falha vira
// `{ status: 'failure', ... }`.
export async function deliverBatch({
  integration, secretPlaintext, batchRow, rawBody, timestamp, deliveryId, idempotencyKey,
  fetchImpl = fetch, allowHttp = false,
}) {
  if (!externalIntegrationsEnabled()) {
    // Gate global desligado: NUNCA chama fetchImpl, NUNCA finge sucesso.
    return { status: 'failure', http_code: null, duration_ms: 0, error: 'EXTERNAL_INTEGRATIONS_DISABLED' };
  }

  const cfg = deliveryConfig();
  const startedAt = Date.now();

  const targetCheck = await assertSafeUrl(integration.target_url, { allowHttp });
  if (!targetCheck.ok) {
    return {
      status: 'failure', http_code: null, duration_ms: Date.now() - startedAt,
      error: `SSRF_BLOCKED:${targetCheck.reason}`,
    };
  }

  const headers = {
    'Content-Type': 'application/json',
    ...buildHeaders({
      rawBody, secret: secretPlaintext, timestamp, deliveryId,
      schemaVersion: batchRow.schema_version, idempotencyKey,
    }),
  };

  let currentUrl = integration.target_url;
  let redirects = 0;

  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    let response;
    try {
      response = await fetchImpl(currentUrl, {
        method: 'POST',
        headers,
        body: rawBody,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const isAbort = e && (e.name === 'AbortError' || e.code === 'ABORT_ERR');
      return {
        status: 'failure', http_code: null, duration_ms: Date.now() - startedAt,
        error: isAbort ? 'TIMEOUT' : 'NETWORK',
      };
    }
    clearTimeout(timer);

    const status = response.status;

    if (status >= 300 && status < 400) {
      const location = response.headers && typeof response.headers.get === 'function'
        ? response.headers.get('location')
        : null;
      if (!location) {
        return {
          status: 'failure', http_code: status, duration_ms: Date.now() - startedAt,
          error: 'REDIRECT_BLOCKED',
        };
      }
      redirects += 1;
      if (redirects > (deliveryConfig().maxRedirects ?? MAX_REDIRECTS)) {
        return {
          status: 'failure', http_code: status, duration_ms: Date.now() - startedAt,
          error: 'TOO_MANY_REDIRECTS',
        };
      }
      let resolvedLocation;
      try {
        resolvedLocation = new URL(location, currentUrl).toString();
      } catch {
        return {
          status: 'failure', http_code: status, duration_ms: Date.now() - startedAt,
          error: 'REDIRECT_BLOCKED',
        };
      }
      const safe = await checkRedirectTarget(resolvedLocation, { allowHttp });
      if (!safe) {
        return {
          status: 'failure', http_code: status, duration_ms: Date.now() - startedAt,
          error: 'REDIRECT_BLOCKED',
        };
      }
      currentUrl = resolvedLocation;
      continue; // segue o hop, revalidando novamente no topo do loop
    }

    const durationMs = Date.now() - startedAt;
    if (status >= cfg.successMin && status <= cfg.successMax) {
      return { status: 'success', http_code: status, duration_ms: durationMs };
    }
    return { status: 'failure', http_code: status, duration_ms: durationMs, error: `HTTP_${status}` };
  }
}

// Tenta entregar até `maxAttempts` vezes. Documenta o backoff-alvo (2s, 6s, 18s, 54s — base 2s,
// fator 3, jitter) mas NÃO bloqueia esperando entre tentativas aqui: em produção o job (Task 9)
// reagenda por vencimento em vez de dormir; nos testes as tentativas rodam imediatamente com o
// mock. Cada tentativa (se `recordAttempt` for passado) é persistida via repo.recordAttempt.
export async function runWithRetries({
  integration, secretPlaintext, batchRow, rawBody, timestamp, deliveryId, idempotencyKey,
  fetchImpl = fetch, allowHttp = false, recordAttempt, maxAttempts,
}) {
  const attempts = maxAttempts ?? deliveryConfig().maxAttempts;
  let lastResult = null;

  for (let attemptNo = 1; attemptNo <= attempts; attemptNo += 1) {
    // eslint-disable-next-line no-await-in-loop
    lastResult = await deliverBatch({
      integration, secretPlaintext, batchRow, rawBody, timestamp, deliveryId, idempotencyKey,
      fetchImpl, allowHttp,
    });

    if (recordAttempt) {
      // eslint-disable-next-line no-await-in-loop
      await recordAttempt({ attemptNo, ...lastResult });
    }

    if (lastResult.status === 'success') {
      return { ...lastResult, attempts: attemptNo };
    }
    // Gate desligado: não adianta re-tentar, o resultado não muda.
    if (lastResult.error === 'EXTERNAL_INTEGRATIONS_DISABLED') {
      return { ...lastResult, attempts: attemptNo };
    }
  }

  return { ...lastResult, attempts };
}
