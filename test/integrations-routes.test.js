// Task 8 (Etapa B — integração webhook em lote): rotas API tenant-safe + auditoria.
//
// Cobre a matriz RBAC/segurança: superadmin exige ?tenant_id= (sem visão global); admin sempre no
// próprio tenant (tenant_id de query/body é IGNORADO); gestor/usuario → 403; cross-tenant em
// /batches/:id/attempts → 404; GET/PUT nunca retornam secret_encrypted/plaintext; POST /secret retorna
// o plaintext uma única vez; PUT com URL SSRF/inválida → 400; com a flag desligada, /test e
// /resend não fingem sucesso; paginação de /batches; auditoria com metadados seguros.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { getPool, applyMigrations, withTx } from './helpers/db.js';
import { signToken } from '../server/auth/jwt.js';
import { authenticate } from '../server/middleware/authenticate.js';
import { createIntegrationsRouter } from '../server/routes/integrations.js';
import { sanitizeError } from '../server/integrations/config.js';
import { encodeSnapshot } from '../server/integrations/payload-snapshot.js';

// Helper: colunas de snapshot exigidas por `integration_delivery_batches` (Etapa B, S1/S2) — usado
// pelos testes de /resend que precisam de um batch REALMENTE entregável (com snapshot), já que
// `attemptBatchDelivery` (S3) agora carrega o snapshot ANTES de checar o secret e recusa
// (PAYLOAD_INTEGRITY) qualquer batch sem ele.
function snapshotSqlFragment(bodyObj = { test: true }) {
  const rawBody = JSON.stringify(bodyObj);
  const snap = encodeSnapshot(rawBody);
  return {
    rawBody,
    columns: 'payload_compressed, payload_sha256, payload_size_bytes, payload_encoding, target_url_snapshot',
    placeholders: '?, ?, ?, ?, ?',
    values: [snap.compressed, snap.sha256, snap.sizeBytes, snap.encoding, VALID_URL],
  };
}

function makeApp(conn) {
  const a = express();
  a.use(express.json());
  a.use('/api/integrations', authenticate, createIntegrationsRouter(conn));
  return a;
}
const bearer = (p) => `Bearer ${signToken(p)}`;

const SUPER = { userId: 910000, tenantId: null, role: 'superadmin' };
const ADMIN1 = { userId: 910050, tenantId: 910001, role: 'admin' };
const ADMIN2 = { userId: 910060, tenantId: 910002, role: 'admin' };
const GESTOR = { userId: 910040, tenantId: 910001, role: 'gestor' };
const USER1 = { userId: 910011, tenantId: 910001, role: 'usuario' };

async function seed(c) {
  await c.query("INSERT INTO tenants (id,name,status) VALUES (910001,'T1','active'),(910002,'T2','active')");
  await c.query(`INSERT INTO users (id,tenant_id,name,email,password_hash,role,status) VALUES
    (910000,NULL,'Super','s@__test__i','x','superadmin','active'),
    (910050,910001,'Admin1','a1@__test__i','x','admin','active'),
    (910040,910001,'Gestor','g@__test__i','x','gestor','active'),
    (910011,910001,'U1','u1@__test__i','x','usuario','active'),
    (910060,910002,'Admin2','a2@__test__i','x','admin','active')`);
}

const VALID_URL = 'https://example.com/webhook';
const SSRF_URL = 'http://169.254.169.254/latest/meta-data';

function validBody(overrides = {}) {
  return {
    active: true,
    target_url: VALID_URL,
    run_at_time: '03:00',
    timezone: 'America/Sao_Paulo',
    include_direct: true,
    include_groups: true,
    include_from_me: true,
    include_audio_transcripts: false,
    ...overrides,
  };
}

const originalFlag = process.env.EXTERNAL_INTEGRATIONS_ENABLED;

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  process.env.INTEGRATIONS_SECRET_KEY = process.env.INTEGRATIONS_SECRET_KEY || '3'.repeat(64);
  await applyMigrations();
});
afterAll(() => getPool().end());
afterEach(() => {
  if (originalFlag === undefined) delete process.env.EXTERNAL_INTEGRATIONS_ENABLED;
  else process.env.EXTERNAL_INTEGRATIONS_ENABLED = originalFlag;
});

describe('integrations routes — RBAC e resolução de tenant', () => {
  it('superadmin SEM tenant_id → 400 (sem visão global)', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/integrations').set('Authorization', bearer(SUPER));
      expect(r.status).toBe(400);
    });
  });

  it('superadmin COM tenant_id → 200', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/integrations?tenant_id=910001').set('Authorization', bearer(SUPER));
      expect(r.status).toBe(200);
      expect(r.body.config).toBeNull();
      expect(typeof r.body.externalEnabled).toBe('boolean');
    });
  });

  it('superadmin com tenant_id inexistente → 404', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/integrations?tenant_id=999999').set('Authorization', bearer(SUPER));
      expect(r.status).toBe(404);
    });
  });

  it('admin opera no próprio tenant; tenant_id de OUTRO no query é IGNORADO', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      // Cria config para T1 via ADMIN1.
      const put = await request(app).put('/api/integrations').set('Authorization', bearer(ADMIN1)).send(validBody());
      expect(put.status).toBe(200);

      // ADMIN1 tenta escopar para T2 via query — deve continuar vendo/afetando só T1.
      const r = await request(app).get('/api/integrations?tenant_id=910002').set('Authorization', bearer(ADMIN1));
      expect(r.status).toBe(200);
      expect(r.body.config).not.toBeNull();
      expect(r.body.config.tenant_id).toBe(910001);

      // Confirma que T2 não foi tocado: ADMIN2 ainda vê config nula.
      const t2 = await request(app).get('/api/integrations').set('Authorization', bearer(ADMIN2));
      expect(t2.body.config).toBeNull();
    });
  });

  it('gestor e usuario → 403 em todos os endpoints', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      expect((await request(app).get('/api/integrations').set('Authorization', bearer(GESTOR))).status).toBe(403);
      expect((await request(app).put('/api/integrations').set('Authorization', bearer(GESTOR)).send(validBody())).status).toBe(403);
      expect((await request(app).post('/api/integrations/secret').set('Authorization', bearer(GESTOR))).status).toBe(403);
      expect((await request(app).post('/api/integrations/test').set('Authorization', bearer(GESTOR))).status).toBe(403);
      expect((await request(app).get('/api/integrations/batches').set('Authorization', bearer(USER1))).status).toBe(403);
      expect((await request(app).get('/api/integrations/batches/1/attempts').set('Authorization', bearer(USER1))).status).toBe(403);
      expect((await request(app).post('/api/integrations/batches/1/resend').set('Authorization', bearer(USER1))).status).toBe(403);
    });
  });
});

describe('integrations routes — PUT / (criar/atualizar config)', () => {
  it('cria e depois atualiza a config; nunca retorna secret_encrypted/plaintext', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const created = await request(app).put('/api/integrations').set('Authorization', bearer(ADMIN1)).send(validBody());
      expect(created.status).toBe(200);
      expect(created.body).not.toHaveProperty('secret_encrypted');
      expect(JSON.stringify(created.body)).not.toMatch(/whsec_/);

      const updated = await request(app).put('/api/integrations').set('Authorization', bearer(ADMIN1)).send(validBody({ active: false }));
      expect(updated.status).toBe(200);
      expect(updated.body.active).toBe(0);
      expect(updated.body).not.toHaveProperty('secret_encrypted');
    });
  });

  it('URL SSRF (metadata) → 400', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).put('/api/integrations').set('Authorization', bearer(ADMIN1)).send(validBody({ target_url: SSRF_URL }));
      expect(r.status).toBe(400);
    });
  });

  it('URL inválida (não é uma URL) → 400', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).put('/api/integrations').set('Authorization', bearer(ADMIN1)).send(validBody({ target_url: 'not-a-url' }));
      expect(r.status).toBe(400);
    });
  });

  it('run_at_time inválido → 400', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).put('/api/integrations').set('Authorization', bearer(ADMIN1)).send(validBody({ run_at_time: '25:99' }));
      expect(r.status).toBe(400);
    });
  });

  it('grava auditoria create_integration/update_integration com metadados seguros (sem secret)', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      await request(app).put('/api/integrations').set('Authorization', bearer(ADMIN1)).send(validBody());
      const [rows] = await c.query(
        "SELECT action, resource, metadata FROM access_logs WHERE tenant_id=910001 AND action='create_integration'");
      expect(rows.length).toBe(1);
      expect(rows[0].resource).toBe('integration');
      const meta = JSON.stringify(rows[0].metadata);
      expect(meta).not.toMatch(/whsec_|secret/i);
    });
  });

  it('active alterado em update grava também toggle_integration', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      await request(app).put('/api/integrations').set('Authorization', bearer(ADMIN1)).send(validBody({ active: true }));
      await request(app).put('/api/integrations').set('Authorization', bearer(ADMIN1)).send(validBody({ active: false }));
      const [rows] = await c.query(
        "SELECT action FROM access_logs WHERE tenant_id=910001 AND action='toggle_integration'");
      expect(rows.length).toBe(1);
    });
  });
});

describe('integrations routes — POST /secret', () => {
  it('retorna o plaintext uma vez; GET seguinte só mostra masked', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      await request(app).put('/api/integrations').set('Authorization', bearer(ADMIN1)).send(validBody());

      const secretRes = await request(app).post('/api/integrations/secret').set('Authorization', bearer(ADMIN1));
      expect(secretRes.status).toBe(200);
      expect(secretRes.body.secret).toMatch(/^whsec_/);
      expect(secretRes.body.masked).toMatch(/^whsec_••••/);

      const getRes = await request(app).get('/api/integrations').set('Authorization', bearer(ADMIN1));
      expect(getRes.body.config.secret_masked).toBe(secretRes.body.masked);
      expect(getRes.body.config).not.toHaveProperty('secret_encrypted');
      expect(JSON.stringify(getRes.body)).not.toContain(secretRes.body.secret);
    });
  });

  it('grava auditoria regenerate_integration_secret sem o valor do secret', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      await request(app).put('/api/integrations').set('Authorization', bearer(ADMIN1)).send(validBody());
      const secretRes = await request(app).post('/api/integrations/secret').set('Authorization', bearer(ADMIN1));

      const [rows] = await c.query(
        "SELECT action, metadata FROM access_logs WHERE tenant_id=910001 AND action='regenerate_integration_secret'");
      expect(rows.length).toBe(1);
      const raw = JSON.stringify(rows[0]);
      expect(raw).not.toContain(secretRes.body.secret);
    });
  });
});

describe('integrations routes — POST /test (gate global)', () => {
  it('flag desligada → {status:"disabled"}, sem tentar entregar', async () => {
    await withTx(async (c) => {
      delete process.env.EXTERNAL_INTEGRATIONS_ENABLED;
      await seed(c); const app = makeApp(c);
      await request(app).put('/api/integrations').set('Authorization', bearer(ADMIN1)).send(validBody());
      const r = await request(app).post('/api/integrations/test').set('Authorization', bearer(ADMIN1));
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('disabled');
    });
  });
});

describe('integrations routes — GET /batches (paginação)', () => {
  it('pagina os lotes do tenant', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const put = await request(app).put('/api/integrations').set('Authorization', bearer(ADMIN1)).send(validBody());
      const integrationId = put.body.id;

      await c.query(`INSERT INTO integration_delivery_batches
        (tenant_id, integration_id, schema_version, window_start, window_end, part, part_total, idempotency_key, status, conversation_count, message_count)
        VALUES
        (910001, ?, 1, '2026-07-20 00:00:00', '2026-07-21 00:00:00', 1, 1, 'k1', 'delivered', 0, 0),
        (910001, ?, 1, '2026-07-21 00:00:00', '2026-07-22 00:00:00', 1, 1, 'k2', 'delivered', 0, 0),
        (910001, ?, 1, '2026-07-22 00:00:00', '2026-07-23 00:00:00', 1, 1, 'k3', 'pending', 0, 0)`,
        [integrationId, integrationId, integrationId]);

      const r = await request(app).get('/api/integrations/batches?page=1&limit=2').set('Authorization', bearer(ADMIN1));
      expect(r.status).toBe(200);
      expect(r.body.total).toBe(3);
      expect(r.body.batches).toHaveLength(2);
      expect(JSON.stringify(r.body)).not.toMatch(/secret/i);
    });
  });
});

describe('integrations routes — cross-tenant em /batches/:id/attempts', () => {
  it('lote de outro tenant → 404', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const put2 = await request(app).put('/api/integrations').set('Authorization', bearer(ADMIN2)).send(validBody());
      const integrationId2 = put2.body.id;
      const [ins] = await c.query(`INSERT INTO integration_delivery_batches
        (tenant_id, integration_id, schema_version, window_start, window_end, part, part_total, idempotency_key, status, conversation_count, message_count)
        VALUES (910002, ?, 1, '2026-07-20 00:00:00', '2026-07-21 00:00:00', 1, 1, 'k-t2', 'delivered', 0, 0)`,
        [integrationId2]);
      const batchId = ins.insertId;

      const r = await request(app).get(`/api/integrations/batches/${batchId}/attempts`).set('Authorization', bearer(ADMIN1));
      expect(r.status).toBe(404);
    });
  });

  it('lote inexistente → 404', async () => {
    await withTx(async (c) => {
      await seed(c); const app = makeApp(c);
      const r = await request(app).get('/api/integrations/batches/999999/attempts').set('Authorization', bearer(ADMIN1));
      expect(r.status).toBe(404);
    });
  });
});

describe('integrations routes — POST /batches/:id/resend (gate global, anti-concorrência)', () => {
  it('flag desligada → bloqueado, sem sucesso falso', async () => {
    await withTx(async (c) => {
      delete process.env.EXTERNAL_INTEGRATIONS_ENABLED;
      await seed(c); const app = makeApp(c);
      const put = await request(app).put('/api/integrations').set('Authorization', bearer(ADMIN1)).send(validBody());
      const integrationId = put.body.id;
      const [ins] = await c.query(`INSERT INTO integration_delivery_batches
        (tenant_id, integration_id, schema_version, window_start, window_end, part, part_total, idempotency_key, status, conversation_count, message_count)
        VALUES (910001, ?, 1, '2026-07-20 00:00:00', '2026-07-21 00:00:00', 1, 1, 'k-resend-1', 'failed', 0, 0)`,
        [integrationId]);
      const batchId = ins.insertId;

      const r = await request(app).post(`/api/integrations/batches/${batchId}/resend`).set('Authorization', bearer(ADMIN1));
      expect(r.status).not.toBe(200);
      expect([400, 409]).toContain(r.status);

      const [rows] = await c.query('SELECT status FROM integration_delivery_batches WHERE id = ?', [batchId]);
      expect(rows[0].status).not.toBe('delivered');
    });
  });

  it('lote já "delivering" → 409 (lock anti-concorrência)', async () => {
    await withTx(async (c) => {
      process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
      await seed(c); const app = makeApp(c);
      const put = await request(app).put('/api/integrations').set('Authorization', bearer(ADMIN1)).send(validBody());
      const integrationId = put.body.id;
      const [ins] = await c.query(`INSERT INTO integration_delivery_batches
        (tenant_id, integration_id, schema_version, window_start, window_end, part, part_total, idempotency_key, status, conversation_count, message_count)
        VALUES (910001, ?, 1, '2026-07-20 00:00:00', '2026-07-21 00:00:00', 1, 1, 'k-resend-2', 'delivering', 0, 0)`,
        [integrationId]);
      const batchId = ins.insertId;

      const r = await request(app).post(`/api/integrations/batches/${batchId}/resend`).set('Authorization', bearer(ADMIN1));
      expect(r.status).toBe(409);
    });
  });

  it('lote de outro tenant → 404 (router.param já revalida posse antes de qualquer claim — R3 Important #1)', async () => {
    await withTx(async (c) => {
      process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
      await seed(c); const app = makeApp(c);
      const put2 = await request(app).put('/api/integrations').set('Authorization', bearer(ADMIN2)).send(validBody());
      const integrationId2 = put2.body.id;
      const [ins] = await c.query(`INSERT INTO integration_delivery_batches
        (tenant_id, integration_id, schema_version, window_start, window_end, part, part_total, idempotency_key, status, conversation_count, message_count)
        VALUES (910002, ?, 1, '2026-07-20 00:00:00', '2026-07-21 00:00:00', 1, 1, 'k-resend-crosstenant', 'pending', 0, 0)`,
        [integrationId2]);
      const batchId = ins.insertId;

      // ADMIN1 (tenant 910001) tentando reenviar um lote do tenant 910002.
      const r = await request(app).post(`/api/integrations/batches/${batchId}/resend`).set('Authorization', bearer(ADMIN1));
      expect(r.status).toBe(404);

      // O batch do outro tenant nunca foi tocado (nem reivindicado).
      const [rows] = await c.query('SELECT status FROM integration_delivery_batches WHERE id = ?', [batchId]);
      expect(rows[0].status).toBe('pending');
    });
  });

  it('lote pending elegível, sem secret configurado → tentativa registrada (SECRET_NOT_SET), batch pending_retry, resposta failure', async () => {
    await withTx(async (c) => {
      process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
      await seed(c); const app = makeApp(c);
      const put = await request(app).put('/api/integrations').set('Authorization', bearer(ADMIN1)).send(validBody());
      const integrationId = put.body.id;
      // Config sem secret_encrypted (rotateSecret nunca chamado) — getSigningSecret retorna null.
      // Batch COM snapshot válido (S3: attemptBatchDelivery carrega o snapshot antes do secret —
      // sem ele, falharia por PAYLOAD_INTEGRITY em vez de SECRET_NOT_SET, o que não é o que este
      // teste quer exercitar).
      const snap = snapshotSqlFragment({ marker: 'resend-nosecret' });
      const [ins] = await c.query(`INSERT INTO integration_delivery_batches
        (tenant_id, integration_id, schema_version, window_start, window_end, part, part_total, idempotency_key, status, conversation_count, message_count, ${snap.columns})
        VALUES (910001, ?, 1, '2026-07-20 00:00:00', '2026-07-21 00:00:00', 1, 1, 'k-resend-nosecret', 'pending', 0, 0, ${snap.placeholders})`,
        [integrationId, ...snap.values]);
      const batchId = ins.insertId;

      const r = await request(app).post(`/api/integrations/batches/${batchId}/resend`).set('Authorization', bearer(ADMIN1));
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('failure');
      expect(r.body.batchStatus).toBe('pending_retry'); // SECRET_NOT_SET é retryable

      const [rows] = await c.query('SELECT status, attempt_count FROM integration_delivery_batches WHERE id = ?', [batchId]);
      expect(rows[0].status).toBe('pending_retry');
      expect(rows[0].attempt_count).toBe(1);

      const [attempts] = await c.query('SELECT * FROM integration_delivery_attempts WHERE batch_id = ?', [batchId]);
      expect(attempts).toHaveLength(1);
      expect(attempts[0].error).toBe('SECRET_NOT_SET');
    });
  });

  it('reenvio manual não colide com retry automático concorrente — segunda claim no mesmo lote é 409/no-op', async () => {
    await withTx(async (c) => {
      process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
      await seed(c); const app = makeApp(c);
      const put = await request(app).put('/api/integrations').set('Authorization', bearer(ADMIN1)).send(validBody());
      const integrationId = put.body.id;
      const [ins] = await c.query(`INSERT INTO integration_delivery_batches
        (tenant_id, integration_id, schema_version, window_start, window_end, part, part_total, idempotency_key, status, conversation_count, message_count)
        VALUES (910001, ?, 1, '2026-07-20 00:00:00', '2026-07-21 00:00:00', 1, 1, 'k-resend-nocollide', 'pending', 0, 0)`,
        [integrationId]);
      const batchId = ins.insertId;

      // Simula o "retry automático" já tendo reivindicado o batch nesta mesma transação (mesma
      // guarda usada pelo job — claimBatchForAttempt) ANTES do reenvio manual chegar.
      const { claimBatchForAttempt } = await import('../server/integrations/repo.js');
      const preClaim = await claimBatchForAttempt(c, batchId, { now: new Date(), includeBlocked: true });
      expect(preClaim.claimed).toBe(true);

      // Reenvio manual concorrente encontra o batch já 'delivering' → 409, nunca reivindica de novo.
      const r = await request(app).post(`/api/integrations/batches/${batchId}/resend`).set('Authorization', bearer(ADMIN1));
      expect(r.status).toBe(409);

      const [rows] = await c.query('SELECT status FROM integration_delivery_batches WHERE id = ?', [batchId]);
      expect(rows[0].status).toBe('delivering'); // continua sob posse de quem reivindicou primeiro
    });
  });

  it('lote "blocked" (gate estava off na criação) é elegível para reenvio manual com o gate ligado', async () => {
    await withTx(async (c) => {
      process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
      await seed(c); const app = makeApp(c);
      const put = await request(app).put('/api/integrations').set('Authorization', bearer(ADMIN1)).send(validBody());
      const integrationId = put.body.id;
      const snap = snapshotSqlFragment({ marker: 'resend-blocked' });
      const [ins] = await c.query(`INSERT INTO integration_delivery_batches
        (tenant_id, integration_id, schema_version, window_start, window_end, part, part_total, idempotency_key, status, conversation_count, message_count, ${snap.columns})
        VALUES (910001, ?, 1, '2026-07-20 00:00:00', '2026-07-21 00:00:00', 1, 1, 'k-resend-blocked', 'blocked', 0, 0, ${snap.placeholders})`,
        [integrationId, ...snap.values]);
      const batchId = ins.insertId;

      const r = await request(app).post(`/api/integrations/batches/${batchId}/resend`).set('Authorization', bearer(ADMIN1));
      // Sem secret configurado, a tentativa falha (SECRET_NOT_SET) mas o ponto do teste é que o
      // batch 'blocked' FOI reivindicado/tentado (não ficou preso em blocked por falta de
      // includeBlocked:true no resend) — resposta 200 com um resultado de tentativa, nunca 409.
      expect(r.status).toBe(200);

      const [rows] = await c.query('SELECT status FROM integration_delivery_batches WHERE id = ?', [batchId]);
      expect(rows[0].status).not.toBe('blocked'); // saiu do estado blocked (virou pending_retry/failed)
    });
  });

  // Etapa B, S3, teste obrigatório 12: reenvio manual usa o MESMO snapshot que o retry
  // automático usaria — nunca reconstrói. Como a rota real não injeta fetchImpl (produção sempre
  // usa o transporte seguro), a prova aqui é que a integridade do snapshot é o que decide o
  // resultado: um snapshot ADULTERADO faz o reenvio recusar com PAYLOAD_INTEGRITY (nunca tenta
  // rede), exatamente a mesma proteção que o job usa — confirmando que ambos os caminhos passam
  // pelo mesmo `attemptBatchDelivery`/`loadBatchSnapshot`, sem lógica divergente de reconstrução.
  it('12. reenvio manual com snapshot ADULTERADO no banco recusa com PAYLOAD_INTEGRITY (mesma proteção do retry automático)', async () => {
    await withTx(async (c) => {
      process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
      await seed(c); const app = makeApp(c);
      const put = await request(app).put('/api/integrations').set('Authorization', bearer(ADMIN1)).send(validBody());
      const integrationId = put.body.id;
      const snap = snapshotSqlFragment({ marker: 'resend-tamper' });
      const [ins] = await c.query(`INSERT INTO integration_delivery_batches
        (tenant_id, integration_id, schema_version, window_start, window_end, part, part_total, idempotency_key, status, conversation_count, message_count, ${snap.columns})
        VALUES (910001, ?, 1, '2026-07-20 00:00:00', '2026-07-21 00:00:00', 1, 1, 'k-resend-tamper', 'pending', 0, 0, ${snap.placeholders})`,
        [integrationId, ...snap.values]);
      const batchId = ins.insertId;

      await c.query(
        'UPDATE integration_delivery_batches SET payload_compressed = ? WHERE id = ?',
        [Buffer.from('nao-e-gzip-valido'), batchId],
      );

      const r = await request(app).post(`/api/integrations/batches/${batchId}/resend`).set('Authorization', bearer(ADMIN1));
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('failure');
      expect(r.body.batchStatus).toBe('failed'); // não-retryable: nunca fica pending_retry

      const [rows] = await c.query('SELECT status FROM integration_delivery_batches WHERE id = ?', [batchId]);
      expect(rows[0].status).toBe('failed');

      const [attempts] = await c.query('SELECT * FROM integration_delivery_attempts WHERE batch_id = ?', [batchId]);
      expect(attempts).toHaveLength(1);
      expect(attempts[0].error).toBe('PAYLOAD_INTEGRITY');
    });
  });

  it('exceção interna no reenvio (secret key inválida) → 500 genérico, log só com código sanitizado (R4)', async () => {
    await withTx(async (c) => {
      process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
      await seed(c); const app = makeApp(c);
      const put = await request(app).put('/api/integrations').set('Authorization', bearer(ADMIN1)).send(validBody());
      const integrationId = put.body.id;
      const [ins] = await c.query(`INSERT INTO integration_delivery_batches
        (tenant_id, integration_id, schema_version, window_start, window_end, part, part_total, idempotency_key, status, conversation_count, message_count)
        VALUES (910001, ?, 1, '2026-07-20 00:00:00', '2026-07-21 00:00:00', 1, 1, 'k-resend-internal-error', 'pending', 0, 0)`,
        [integrationId]);
      const batchId = ins.insertId;

      // Força `integrationsSecretKey()` a lançar DENTRO do handler de resend (depois do claim,
      // exatamente o cenário do R4: attemptBatchDelivery decifraria o secret/montaria a URL) —
      // sem precisar mockar módulos, só uma env var momentaneamente inválida.
      const originalKey = process.env.INTEGRATIONS_SECRET_KEY;
      process.env.INTEGRATIONS_SECRET_KEY = 'not-a-valid-key';

      const logs = [];
      const originalError = console.error;
      console.error = (...args) => logs.push(args.join(' '));

      let r;
      try {
        r = await request(app).post(`/api/integrations/batches/${batchId}/resend`).set('Authorization', bearer(ADMIN1));
      } finally {
        console.error = originalError;
        process.env.INTEGRATIONS_SECRET_KEY = originalKey;
      }

      expect(r.status).toBe(500);
      expect(r.body).toEqual({ error: 'Falha ao reenviar o lote' }); // resposta ao cliente já genérica

      const joined = logs.join('\n');
      expect(joined.length).toBeGreaterThan(0);
      // Só o código fechado esperado para essa falha (config inválida) — nunca a mensagem crua/stack.
      expect(joined).toContain(sanitizeError(new Error('INTEGRATIONS_SECRET_KEY inválida — deve decodificar para exatamente 32 bytes (64 hex ou base64)')));
      expect(joined).not.toContain('INTEGRATIONS_SECRET_KEY inválida'); // e.message cru NUNCA logado
      expect(joined).not.toContain('at ');       // sem frames de stack trace
      expect(joined).not.toMatch(/https?:\/\//); // sem URL completa
      expect(joined).not.toContain('whsec_');    // sem prefixo de secret

      // Batch não fica preso em 'delivering' — o catch libera a reivindicação.
      const [rows] = await c.query('SELECT status FROM integration_delivery_batches WHERE id = ?', [batchId]);
      expect(rows[0].status).not.toBe('delivering');
    });
  });
});

describe('sanitizeError — mapeamento fechado (R4, compartilhado job+rotas)', () => {
  it('erro com URL/detalhe sensível na mensagem nunca é ecoado — só o código fechado', () => {
    const urlError = new TypeError('Invalid URL: https://secret-internal.example.com/webhook?token=abc123');
    const code = sanitizeError(urlError);
    expect(code).toBe('URL_ERROR');
    expect(code).not.toMatch(/https?:\/\//);
    expect(code).not.toContain('secret-internal');
  });

  it('erro de cripto (decrypt/cipher) mapeia para CRYPTO_ERROR sem detalhe', () => {
    const cryptoError = new Error('Unsupported state or unable to authenticate data (auth tag mismatch)');
    cryptoError.name = 'Error';
    expect(sanitizeError(cryptoError)).toBe('CRYPTO_ERROR');
  });

  it('erro desconhecido nunca vaza e.message — cai em UNKNOWN', () => {
    const weird = new Error('algo com um whsec_abc123 e https://exemplo.com aqui dentro');
    const code = sanitizeError(weird);
    expect(['UNKNOWN', 'CONFIG_ERROR']).toContain(code);
    expect(code).not.toMatch(/https?:\/\//);
    expect(code).not.toContain('whsec_');
  });
});
