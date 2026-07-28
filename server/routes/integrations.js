import express from 'express';
import { requireActor } from '../middleware/actor.js';
import { writeAudit, clientIp } from '../audit.js';
import { generateSecret } from '../integrations/secret.js';
import { assertSafeUrl } from '../integrations/ssrf.js';
import { externalIntegrationsEnabled, isProdLike, integrationsSecretKey } from '../integrations/config.js';
import { buildPayload } from '../integrations/payload.js';
import { deliverBatch } from '../integrations/delivery.js';
import { attemptBatchDelivery } from '../integrations/deliver-batch-attempt.js';
import {
  getConfig, publicConfig, upsertConfig, rotateSecret, getSigningSecret,
  listBatches, getBatch, listAttempts,
  claimBatchForAttempt, releaseClaim,
} from '../integrations/repo.js';

// Rotas tenant-safe de Configurações > Integrações (Etapa B — integração por webhook em lote).
//
// Determinação de tenant (a crux de segurança desta rota): admin → SEMPRE req.actor.tenant_id,
// ignorando qualquer tenant_id vindo de query/body. superadmin → SEM visão global: exige
// ?tenant_id= (equivale ao "modo cliente" do TenantContext do frontend); sem ele, 400. Em ambos
// os casos o tenant é revalidado contra a tabela `tenants` (404 se inexistente) — nunca confia
// cegamente no id.

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;

function parsePaging(q) {
  let limit = parseInt(q.limit, 10);
  if (Number.isNaN(limit) || limit < 1) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;
  let page = parseInt(q.page, 10);
  if (Number.isNaN(page) || page < 1) page = 1;
  return { page, limit, offset: (page - 1) * limit };
}

const RUN_AT_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    if (typeof Intl.supportedValuesOf === 'function') {
      return Intl.supportedValuesOf('timeZone').includes(tz);
    }
  } catch {
    // Ambiente sem supportedValuesOf: cai no fallback abaixo.
  }
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function createIntegrationsRouter(pool) {
  const router = express.Router();
  router.use(requireActor(pool, ['admin', 'superadmin']));

  // Rate limit simples em memória, por tenant+ação (test/resend). Reinicia ao reiniciar o
  // processo — suficiente como salvaguarda anti-abuso; não é um rate limiter distribuído.
  const rateBuckets = new Map();
  function checkRateLimit(tenantId, action) {
    const key = `${tenantId}:${action}`;
    const now = Date.now();
    const bucket = rateBuckets.get(key) || [];
    const fresh = bucket.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (fresh.length >= RATE_LIMIT_MAX) {
      rateBuckets.set(key, fresh);
      return false;
    }
    fresh.push(now);
    rateBuckets.set(key, fresh);
    return true;
  }

  // Resolve o tenant efetivo do request, aplicando o RBAC de acima. Nunca lê tenant_id de query
  // /body para admin (ignorado deliberadamente). Popula req.tenantId; responde 400/404 direto
  // quando não resolve.
  async function resolveTenant(req, res, next) {
    try {
      if (req.actor.role === 'superadmin') {
        const tenantId = req.query.tenant_id;
        if (!tenantId) {
          return res.status(400).json({ error: 'tenant_id obrigatório' });
        }
        const tid = Number(tenantId);
        if (!Number.isInteger(tid)) {
          return res.status(400).json({ error: 'tenant_id obrigatório' });
        }
        const [rows] = await pool.query('SELECT id FROM tenants WHERE id = ?', [tid]);
        if (!rows[0]) return res.status(404).json({ error: 'Cliente não encontrado' });
        req.tenantId = tid;
        return next();
      }
      // admin: sempre o próprio tenant, ignora query/body.
      req.tenantId = Number(req.actor.tenant_id);
      return next();
    } catch (e) {
      console.error('resolve tenant (integrations):', e);
      return res.status(500).json({ error: 'Erro interno' });
    }
  }
  router.use(resolveTenant);

  // ---- GET / — config (mascarada) + flag global ----
  router.get('/', async (req, res) => {
    try {
      const row = await getConfig(pool, req.tenantId);
      res.json({ config: publicConfig(row), externalEnabled: externalIntegrationsEnabled() });
    } catch (e) {
      console.error('get integration config:', e);
      res.status(500).json({ error: 'Falha ao carregar a integração' });
    }
  });

  // ---- PUT / — criar/atualizar config ----
  router.put('/', async (req, res) => {
    try {
      const body = req.body || {};
      const {
        active, target_url: targetUrl, run_at_time: runAtTime, timezone,
        include_direct: includeDirect, include_groups: includeGroups,
        include_from_me: includeFromMe, include_audio_transcripts: includeAudioTranscripts,
      } = body;

      if (typeof targetUrl !== 'string' || !targetUrl) {
        return res.status(400).json({ error: 'target_url é obrigatório' });
      }
      const urlCheck = await assertSafeUrl(targetUrl, { allowHttp: !isProdLike() });
      if (!urlCheck.ok) {
        return res.status(400).json({ error: `target_url inválida (${urlCheck.reason})` });
      }
      if (typeof runAtTime !== 'string' || !RUN_AT_TIME_RE.test(runAtTime)) {
        return res.status(400).json({ error: 'run_at_time inválido (formato HH:MM)' });
      }
      if (!isValidTimezone(timezone)) {
        return res.status(400).json({ error: 'timezone inválido' });
      }

      const existing = await getConfig(pool, req.tenantId);
      const patch = {
        active: active ? 1 : 0,
        target_url: targetUrl,
        run_at_time: runAtTime,
        timezone,
        include_direct: includeDirect ? 1 : 0,
        include_groups: includeGroups ? 1 : 0,
        include_from_me: includeFromMe ? 1 : 0,
        include_audio_transcripts: includeAudioTranscripts ? 1 : 0,
      };
      const updated = await upsertConfig(pool, req.tenantId, patch, req.actor.id);

      const isCreate = !existing;
      const toggled = !isCreate && Number(existing.active) !== patch.active;
      writeAudit(pool, {
        tenantId: req.tenantId, actor: req.actor,
        action: isCreate ? 'create_integration' : 'update_integration',
        resource: 'integration', resourceId: updated.id, ip: clientIp(req),
        metadata: { active: patch.active === 1 },
      });
      if (toggled) {
        writeAudit(pool, {
          tenantId: req.tenantId, actor: req.actor, action: 'toggle_integration',
          resource: 'integration', resourceId: updated.id, ip: clientIp(req),
          metadata: { active: patch.active === 1 },
        });
      }

      res.json(publicConfig(updated));
    } catch (e) {
      console.error('put integration config:', e);
      res.status(500).json({ error: 'Falha ao salvar a integração' });
    }
  });

  // ---- POST /secret — (re)gerar secret ----
  router.post('/secret', async (req, res) => {
    try {
      const existing = await getConfig(pool, req.tenantId);
      if (!existing) return res.status(404).json({ error: 'Integração não configurada' });
      const { plaintext, encrypted, masked } = generateSecret(integrationsSecretKey());
      await rotateSecret(pool, req.tenantId, { encrypted, masked });
      writeAudit(pool, {
        tenantId: req.tenantId, actor: req.actor, action: 'regenerate_integration_secret',
        resource: 'integration', resourceId: existing.id, ip: clientIp(req),
      });
      res.json({ secret: plaintext, masked });
    } catch (e) {
      console.error('regenerate integration secret:', e);
      res.status(500).json({ error: 'Falha ao gerar o segredo' });
    }
  });

  // ---- POST /test — teste controlado (sem dados reais) ----
  router.post('/test', async (req, res) => {
    try {
      if (!checkRateLimit(req.tenantId, 'test')) {
        return res.status(429).json({ error: 'Muitas tentativas, aguarde um momento' });
      }
      if (!externalIntegrationsEnabled()) {
        writeAudit(pool, {
          tenantId: req.tenantId, actor: req.actor, action: 'test_integration',
          resource: 'integration', ip: clientIp(req), status: 'ok', metadata: { disabled: true },
        });
        return res.json({ status: 'disabled' });
      }
      const config = await getConfig(pool, req.tenantId);
      if (!config) return res.status(400).json({ error: 'integração não configurada' });
      const secretPlaintext = await getSigningSecret(pool, req.tenantId, integrationsSecretKey());
      if (!secretPlaintext) return res.status(400).json({ error: 'secret não configurado' });

      const urlCheck = await assertSafeUrl(config.target_url, { allowHttp: !isProdLike() });
      if (!urlCheck.ok) {
        return res.status(400).json({ error: `target_url inválida (${urlCheck.reason})` });
      }

      // Payload sintético mínimo — sem dados reais de mensagens.
      const now = new Date();
      const payload = buildPayload({
        tenant: { id: req.tenantId },
        integration: config,
        window: { start: now, end: now },
        conversations: [],
        messages: [],
        schemaVersion: 1,
      });
      payload.test = true;
      const rawBody = JSON.stringify(payload);
      const timestamp = String(Math.floor(now.getTime() / 1000));
      const deliveryId = `test-${req.tenantId}-${timestamp}`;

      // O secret é decifrado em memória (nunca logado) e usado para assinar de verdade — o
      // receptor pode recomputar HMAC-SHA256(secret, `${timestamp}.${rawBody}`) com o MESMO
      // plaintext que copiou da UI e validar a assinatura de ponta a ponta (não é mais um teste
      // só de conectividade/SSRF: a assinatura enviada aqui é verificável).
      const result = await deliverBatch({
        integration: config,
        secretPlaintext,
        batchRow: { schema_version: 1 },
        rawBody,
        timestamp,
        deliveryId,
        idempotencyKey: deliveryId,
        allowHttp: !isProdLike(),
      });

      writeAudit(pool, {
        tenantId: req.tenantId, actor: req.actor, action: 'test_integration', resource: 'integration',
        resourceId: config.id, ip: clientIp(req), status: result.status === 'success' ? 'ok' : 'fail',
        metadata: { httpCode: result.http_code },
      });

      res.json({ status: result.status, http_code: result.http_code });
    } catch (e) {
      console.error('test integration:', e);
      res.status(500).json({ error: 'Falha ao testar a integração' });
    }
  });

  // ---- GET /batches — lista paginada ----
  router.get('/batches', async (req, res) => {
    try {
      const { page, limit } = parsePaging(req.query);
      const { rows, total } = await listBatches(pool, req.tenantId, { page, limit });
      res.json({ page, limit, total, batches: rows });
    } catch (e) {
      console.error('list integration batches:', e);
      res.status(500).json({ error: 'Falha ao listar os lotes' });
    }
  });

  // Resolve+isola um batch por :id no escopo do tenant. 404 cross-tenant/inexistente.
  router.param('id', async (req, res, next, id) => {
    try {
      const bid = Number(id);
      if (!Number.isInteger(bid)) return res.status(404).json({ error: 'Lote não encontrado' });
      const batch = await getBatch(pool, req.tenantId, bid);
      if (!batch) return res.status(404).json({ error: 'Lote não encontrado' });
      req.batch = batch;
      return next();
    } catch (e) {
      console.error('resolve integration batch:', e);
      return res.status(500).json({ error: 'Erro interno' });
    }
  });

  // ---- GET /batches/:id/attempts ----
  router.get('/batches/:id/attempts', async (req, res) => {
    try {
      const attempts = await listAttempts(pool, req.tenantId, req.batch.id);
      res.json({ attempts });
    } catch (e) {
      console.error('list integration batch attempts:', e);
      res.status(500).json({ error: 'Falha ao listar as tentativas' });
    }
  });

  // ---- POST /batches/:id/resend ----
  //
  // Segurança/concorrência (R4 — ver docs/superpowers/plans/2026-07-28-etapaB-hardening.md):
  // 1. `router.param('id', ...)` acima JÁ revalidou que o batch pertence a `req.tenantId`
  //    (getBatch tenant-scoped, 404 se não achar) — nunca reivindicamos um batch sem confirmar
  //    posse antes.
  // 2. Gate desligado → 409, nenhuma tentativa de entrega (mesma politica do job: gate OFF nunca
  //    finge sucesso nem consome tentativa).
  // 3. A guarda de concorrência é a MESMA usada pelo job (`claimBatchForAttempt`, UPDATE
  //    condicional) — um reenvio manual concorrente com o ciclo automático do job (ou com outro
  //    reenvio) nunca reivindica o mesmo batch duas vezes; `claimed:false` vira 409.
  // 4. A entrega em si usa o MESMO helper (`attemptBatchDelivery`) que o job usa na Fase 2 — evita
  //    duas implementações divergentes de "reconstruir payload + entregar + classificar
  //    retryable/non-retryable + gravar attempt/transição de estado".
  router.post('/batches/:id/resend', async (req, res) => {
    try {
      if (!checkRateLimit(req.tenantId, 'resend')) {
        return res.status(429).json({ error: 'Muitas tentativas, aguarde um momento' });
      }
      if (!externalIntegrationsEnabled()) {
        return res.status(409).json({ error: 'integração externa desativada no ambiente' });
      }

      const now = new Date();
      const claim = await claimBatchForAttempt(pool, req.batch.id, { now, includeBlocked: true });
      if (!claim.claimed) {
        return res.status(409).json({ error: 'Lote já está em entrega' });
      }

      const config = await getConfig(pool, req.tenantId);
      if (!config) {
        await releaseClaim(pool, req.batch.id, { toStatus: req.batch.status });
        return res.status(400).json({ error: 'integração não configurada' });
      }

      const result = await attemptBatchDelivery(pool, {
        tenantId: req.tenantId,
        integration: config,
        batch: req.batch,
        now,
        secretKey: integrationsSecretKey(),
        allowHttp: !isProdLike(),
        deliveryIdPrefix: 'resend',
        auditAction: 'resend_integration_batch',
      });

      res.json({
        status: result.attemptStatus === 'delivered' ? 'success' : 'failure',
        http_code: result.httpCode,
        batchStatus: result.attemptStatus,
      });
    } catch (e) {
      console.error('resend integration batch:', e);
      try { await releaseClaim(pool, req.batch.id, { toStatus: 'failed' }); } catch { /* noop */ }
      res.status(500).json({ error: 'Falha ao reenviar o lote' });
    }
  });

  return router;
}
