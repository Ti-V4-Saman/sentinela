// Entrega HTTP do batch (Etapa B — integração em lote): gate global, defesa SSRF a cada entrega
// (incluindo redirects manuais), timeout, sucesso só 200–299, erro sempre sanitizado.
//
// Transporte (R1 — hardening anti DNS-rebinding): por padrão (sem `fetchImpl` explícito) a entrega
// usa `secureDeliver` (transport.js), que reaproveita a MESMA validação SSRF hop-a-hop mas prende a
// conexão TCP ao IP já validado (via `lookup` do node:http(s)) — elimina a janela de rebinding entre
// validação e conexão que existiria usando `fetch` (que faz sua própria resolução DNS depois de
// `assertSafeUrl` já ter validado). `fetchImpl` continua aceito por compatibilidade com os testes
// existentes (mock determinístico de rede) — quando fornecido, usa o caminho antigo baseado em
// fetch+checkRedirectTarget; produção (rotas e job) NUNCA passa `fetchImpl`, então sempre usa o
// transporte seguro.
//
// Nunca segue redirect automaticamente: no caminho `fetchImpl` (fetch é chamado com
// `redirect: 'manual'`) cada hop é validado por `checkRedirectTarget` (SSRF) ANTES de ser seguido;
// no caminho `secureDeliver` cada hop é revalidado do zero internamente (transport.js). Delegar o
// "seguir redirect" a um cliente HTTP reabriria o vetor SSRF que `ssrf.js` fecha.
//
// Erros são reduzidos a códigos curtos e sanitizados (nunca secret, nunca URL crua, nunca corpo de
// resposta): `EXTERNAL_INTEGRATIONS_DISABLED`, `SSRF_BLOCKED:<reason>`, `REDIRECT_BLOCKED`,
// `TOO_MANY_REDIRECTS`, `TIMEOUT`, `NETWORK`, `HTTP_<code>`.

import { assertSafeUrl, checkRedirectTarget } from './ssrf.js';
import { buildHeaders } from './signature.js';
import { externalIntegrationsEnabled, deliveryConfig } from './config.js';
import { secureDeliver } from './transport.js';

// Caminho legado (só usado quando o chamador injeta `fetchImpl` explicitamente — hoje só os
// testes): fetch + assertSafeUrl/checkRedirectTarget separados. NÃO é o caminho de produção.
async function deliverViaFetchImpl({
  integration, targetUrl, rawBody, headers, fetchImpl, allowHttp, cfg, startedAt,
}) {
  const targetCheck = await assertSafeUrl(targetUrl, { allowHttp });
  if (!targetCheck.ok) {
    return {
      status: 'failure', http_code: null, duration_ms: Date.now() - startedAt,
      error: `SSRF_BLOCKED:${targetCheck.reason}`,
    };
  }

  let currentUrl = targetUrl;
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
      if (redirects > deliveryConfig().maxRedirects) {
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

// Executa uma única tentativa de entrega. Nunca lança: qualquer falha vira
// `{ status: 'failure', ... }`.
//
// `targetUrl` (opcional): destino EFETIVO da entrega — quando informado, sobrepõe
// `integration.target_url` tanto na validação SSRF quanto na conexão real. Etapa B, S3: o
// chamador (deliver-batch-attempt.js) sempre passa o `target_url_snapshot` do batch aqui, para que
// retry/reenvio entreguem ao destino congelado no momento da criação, não ao destino atual da
// integração (que pode ter mudado). Default `integration.target_url` mantém compatibilidade com
// chamadores que ainda não têm um snapshot (ex.: POST /test, que nunca persiste batch).
export async function deliverBatch({
  integration, secretPlaintext, batchRow, rawBody, timestamp, deliveryId, idempotencyKey,
  fetchImpl, allowHttp = false, lookupImpl, targetUrl,
}) {
  if (!externalIntegrationsEnabled()) {
    // Gate global desligado: NUNCA conecta (nem fetchImpl nem secureDeliver), NUNCA finge sucesso.
    return { status: 'failure', http_code: null, duration_ms: 0, error: 'EXTERNAL_INTEGRATIONS_DISABLED' };
  }

  const cfg = deliveryConfig();
  const startedAt = Date.now();
  const effectiveTargetUrl = targetUrl ?? integration.target_url;

  const headers = {
    'Content-Type': 'application/json',
    ...buildHeaders({
      rawBody, secret: secretPlaintext, timestamp, deliveryId,
      schemaVersion: batchRow.schema_version, idempotencyKey,
    }),
  };

  if (typeof fetchImpl === 'function') {
    return deliverViaFetchImpl({
      integration, targetUrl: effectiveTargetUrl, rawBody, headers, fetchImpl, allowHttp, cfg, startedAt,
    });
  }

  const result = await secureDeliver({
    url: effectiveTargetUrl,
    method: 'POST',
    headers,
    body: rawBody,
    allowHttp,
    timeoutMs: cfg.timeoutMs,
    maxRedirects: cfg.maxRedirects,
    ...(lookupImpl ? { lookupImpl } : {}),
  });

  // secureDeliver já mede duration_ms desde sua própria chamada; recalcula com o startedAt desta
  // tentativa (inclui o tempo de montagem de headers, desprezível) para manter o contrato existente.
  return {
    status: result.status,
    http_code: result.http_code,
    duration_ms: Date.now() - startedAt,
    ...(result.error ? { error: result.error } : {}),
  };
}

// Tenta entregar até `maxAttempts` vezes. Documenta o backoff-alvo (2s, 6s, 18s, 54s — base 2s,
// fator 3, jitter) mas NÃO bloqueia esperando entre tentativas aqui: em produção o job (Task 9)
// reagenda por vencimento em vez de dormir; nos testes as tentativas rodam imediatamente com o
// mock. Cada tentativa (se `recordAttempt` for passado) é persistida via repo.recordAttempt.
export async function runWithRetries({
  integration, secretPlaintext, batchRow, rawBody, timestamp, deliveryId, idempotencyKey,
  fetchImpl, allowHttp = false, lookupImpl, recordAttempt, maxAttempts, targetUrl,
}) {
  const attempts = maxAttempts ?? deliveryConfig().maxAttempts;
  let lastResult = null;

  for (let attemptNo = 1; attemptNo <= attempts; attemptNo += 1) {
    // eslint-disable-next-line no-await-in-loop
    lastResult = await deliverBatch({
      integration, secretPlaintext, batchRow, rawBody, timestamp, deliveryId, idempotencyKey,
      fetchImpl, allowHttp, lookupImpl, targetUrl,
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
