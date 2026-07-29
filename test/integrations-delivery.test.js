import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getPool, applyMigrations, withTx } from './helpers/db.js';
import { deliverBatch, runWithRetries } from '../server/integrations/delivery.js';
import {
  createBatch, loadWindowData, loadBatchSnapshot, listBatches, getBatch,
  claimBatchForAttempt,
} from '../server/integrations/repo.js';
import { encodeSnapshot } from '../server/integrations/payload-snapshot.js';
import { buildPayload, chunkPayload } from '../server/integrations/payload.js';
import { idempotencyKey } from '../server/integrations/window.js';
import { encryptSecret } from '../server/integrations/secret.js';
import { attemptBatchDelivery } from '../server/integrations/deliver-batch-attempt.js';

// Helper de teste: monta os campos de snapshot mínimos exigidos por createBatch a partir de um
// corpo qualquer (default determinístico) — usado pelos testes que só querem exercitar a
// idempotência/metadata do batch, sem se importar com o conteúdo exato do payload.
function minimalSnapshotParams(bodyObj = { test: true }) {
  const rawBody = JSON.stringify(bodyObj);
  const snap = encodeSnapshot(rawBody);
  return {
    payloadCompressed: snap.compressed,
    payloadSha256: snap.sha256,
    payloadSizeBytes: snap.sizeBytes,
    payloadEncoding: snap.encoding,
    targetUrlSnapshot: 'https://example.com/hook',
    contentOptionsSnapshot: { include_direct: true, include_groups: true, include_from_me: true, include_audio_transcripts: false },
  };
}

const SECRET = 'whsec_super-secret-plaintext-value';
const TARGET_URL = 'https://example.com/webhook';

const baseIntegration = {
  target_url: TARGET_URL,
  include_direct: 1,
  include_groups: 1,
  include_from_me: 1,
  include_audio_transcripts: 0,
};

const baseBatchRow = { schema_version: 1 };

function baseArgs(overrides = {}) {
  return {
    integration: baseIntegration,
    secretPlaintext: SECRET,
    batchRow: baseBatchRow,
    rawBody: JSON.stringify({ hello: 'world' }),
    timestamp: '1700000000',
    deliveryId: 'delivery-1',
    idempotencyKey: 'idem-key-1',
    allowHttp: true, // testes usam mock local; produção usaria false
    ...overrides,
  };
}

function fakeHeaders(map = {}) {
  return { get: (k) => map[k.toLowerCase()] ?? map[k] ?? null };
}

const originalFlag = process.env.EXTERNAL_INTEGRATIONS_ENABLED;

beforeAll(async () => { await applyMigrations(); });
afterAll(() => getPool().end());
afterEach(() => {
  if (originalFlag === undefined) delete process.env.EXTERNAL_INTEGRATIONS_ENABLED;
  else process.env.EXTERNAL_INTEGRATIONS_ENABLED = originalFlag;
});

describe('deliverBatch — gate global EXTERNAL_INTEGRATIONS_ENABLED', () => {
  it('desligado: não chama fetchImpl, retorna failure EXTERNAL_INTEGRATIONS_DISABLED, nunca success', async () => {
    delete process.env.EXTERNAL_INTEGRATIONS_ENABLED;
    let called = false;
    const fetchImpl = async () => { called = true; return { status: 200, headers: fakeHeaders() }; };

    const result = await deliverBatch(baseArgs({ fetchImpl }));

    expect(called).toBe(false);
    expect(result.status).toBe('failure');
    expect(result.http_code).toBeNull();
    expect(result.error).toBe('EXTERNAL_INTEGRATIONS_DISABLED');
  });

  it('desligado com valor não-estrito (\'1\', \'TRUE\', etc.) continua bloqueado', async () => {
    process.env.EXTERNAL_INTEGRATIONS_ENABLED = '1';
    let called = false;
    const fetchImpl = async () => { called = true; return { status: 200, headers: fakeHeaders() }; };

    const result = await deliverBatch(baseArgs({ fetchImpl }));

    expect(called).toBe(false);
    expect(result.status).toBe('failure');
    expect(result.error).toBe('EXTERNAL_INTEGRATIONS_DISABLED');
  });
});

describe('deliverBatch — ligado, mock de rede', () => {
  it('mock 200 → success + duration_ms presente', async () => {
    process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
    const fetchImpl = async () => ({ status: 200, headers: fakeHeaders() });

    const result = await deliverBatch(baseArgs({ fetchImpl }));

    expect(result.status).toBe('success');
    expect(result.http_code).toBe(200);
    expect(typeof result.duration_ms).toBe('number');
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('mock 299 (limite superior da faixa) → success', async () => {
    process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
    const fetchImpl = async () => ({ status: 299, headers: fakeHeaders() });
    const result = await deliverBatch(baseArgs({ fetchImpl }));
    expect(result.status).toBe('success');
  });

  it('mock 500 → failure, error HTTP_500, sem corpo de resposta no erro', async () => {
    process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
    const fetchImpl = async () => ({
      status: 500, headers: fakeHeaders(),
      text: async () => 'corpo sigiloso da resposta que nunca deve vazar',
    });

    const result = await deliverBatch(baseArgs({ fetchImpl }));

    expect(result.status).toBe('failure');
    expect(result.http_code).toBe(500);
    expect(result.error).toBe('HTTP_500');
    expect(result.error).not.toMatch(/corpo sigiloso/);
  });

  it('mock que rejeita (erro de rede) → failure NETWORK, sanitizado', async () => {
    process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
    const fetchImpl = async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:443'); };

    const result = await deliverBatch(baseArgs({ fetchImpl }));

    expect(result.status).toBe('failure');
    expect(result.error).toBe('NETWORK');
    expect(result.error).not.toMatch(/ECONNREFUSED|10\.0\.0\.5/);
  });

  it('mock que aborta por timeout → failure TIMEOUT, sanitizado', async () => {
    process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
    const fetchImpl = async (_url, { signal }) => new Promise((resolve, reject) => {
      const abort = () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      };
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort);
    });

    // Simula o abort imediatamente (sem esperar 15s reais): dispara o abort do controller
    // manualmente encurtando o timeout via um fetchImpl que aborta assim que chamado.
    const fastAbortFetch = async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    };

    const result = await deliverBatch(baseArgs({ fetchImpl: fastAbortFetch }));

    expect(result.status).toBe('failure');
    expect(result.error).toBe('TIMEOUT');
    void fetchImpl;
  });

  it('302 cujo Location resolve para IP privado → bloqueado (REDIRECT_BLOCKED), sem seguir', async () => {
    process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
    let callCount = 0;
    const fetchImpl = async () => {
      callCount += 1;
      return {
        status: 302,
        headers: fakeHeaders({ location: 'http://169.254.169.254/latest/meta-data' }),
      };
    };

    const result = await deliverBatch(baseArgs({ fetchImpl, allowHttp: true }));

    expect(result.status).toBe('failure');
    expect(result.error).toBe('REDIRECT_BLOCKED');
    expect(callCount).toBe(1); // não seguiu o redirect
  });

  it('URL alvo já bloqueada por SSRF (ex.: localhost) → failure SSRF_BLOCKED, sem chamar fetch', async () => {
    process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
    let called = false;
    const fetchImpl = async () => { called = true; return { status: 200, headers: fakeHeaders() }; };

    const result = await deliverBatch(baseArgs({
      fetchImpl,
      integration: { ...baseIntegration, target_url: 'https://127.0.0.1/webhook' },
      allowHttp: false,
    }));

    expect(called).toBe(false);
    expect(result.status).toBe('failure');
    expect(result.error).toMatch(/^SSRF_BLOCKED:/);
  });

  it('erro nunca contém o secret plaintext nem a URL alvo', async () => {
    process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
    const fetchImpl = async () => ({ status: 503, headers: fakeHeaders() });

    const result = await deliverBatch(baseArgs({ fetchImpl }));

    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(SECRET);
    expect(serialized).not.toMatch(TARGET_URL);
  });
});

// R1 — hardening anti DNS-rebinding: quando NENHUM fetchImpl é passado (o caso real de produção —
// rotas e job nunca passam fetchImpl), deliverBatch delega ao transporte seguro (secureDeliver,
// transport.js), que prende a conexão TCP ao IP já validado por assertSafeUrl. Estes testes não
// abrem socket real (nenhum servidor local aqui) — o alvo público fictício nunca é alcançável, e
// isso é exatamente o ponto: provam que a defesa (bloqueio SSRF / não-segunda-resolução) age ANTES
// de qualquer tentativa de conexão de rede, sem depender de fetchImpl. O caminho de socket real
// (handshake TLS/SNI/Host contra servidor local) é coberto em test/integrations-transport.test.js.
describe('deliverBatch — sem fetchImpl (produção): usa o transporte seguro (secureDeliver) com lookupImpl injetado', () => {
  it('URL alvo com DNS resolvendo para IP privado é bloqueada (SSRF_BLOCKED) sem fetchImpl', async () => {
    process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
    const lookupImpl = async () => [{ address: '10.0.0.5', family: 4 }];

    const result = await deliverBatch(baseArgs({
      fetchImpl: undefined,
      lookupImpl,
      integration: { ...baseIntegration, target_url: 'https://internal-only.example/webhook' },
      allowHttp: false,
    }));

    expect(result.status).toBe('failure');
    expect(result.error).toMatch(/^SSRF_BLOCKED:/);
  });

  it('anti-rebinding: lookupImpl (validação) é chamado exatamente 1 vez por tentativa — nunca uma 2ª resolução', async () => {
    process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
    let calls = 0;
    const lookupImpl = async () => {
      calls += 1;
      // Se houvesse uma 2ª resolução (rebinding), devolveria metadata — nunca deve ser alcançada
      // pelo cliente HTTP, que usa apenas o IP já validado pela 1ª chamada.
      return calls === 1
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '169.254.169.254', family: 4 }];
    };

    const result = await deliverBatch(baseArgs({
      fetchImpl: undefined,
      lookupImpl,
      integration: { ...baseIntegration, target_url: 'https://example.com/webhook' },
      allowHttp: false,
    }));

    // Sem servidor real escutando em example.com/93.184.216.34 de verdade, a conexão falha
    // (NETWORK/TIMEOUT) — o que importa aqui é que o resolver só foi consultado 1 vez: a defesa
    // nunca dá ao atacante uma segunda chance de trocar a resposta DNS.
    expect(result.status).toBe('failure');
    expect(calls).toBe(1);
  });

  it('gate desligado: nem lookupImpl nem qualquer conexão são chamados', async () => {
    delete process.env.EXTERNAL_INTEGRATIONS_ENABLED;
    let called = false;
    const lookupImpl = async () => { called = true; return [{ address: '93.184.216.34', family: 4 }]; };

    const result = await deliverBatch(baseArgs({ fetchImpl: undefined, lookupImpl }));

    expect(called).toBe(false);
    expect(result.status).toBe('failure');
    expect(result.error).toBe('EXTERNAL_INTEGRATIONS_DISABLED');
  });
});

// Regressão do defeito C1 (crítico): antes desta correção, o servidor assinava deliveries com o
// HASH persistido (sha256 do secret), não com o PLAINTEXT que o usuário copiou uma única vez da
// UI — um receptor real, que só tem o plaintext, NUNCA conseguia validar a assinatura recebida.
// Este teste simula exatamente esse receptor: recebe rawBody/timestamp/signature via um mock de
// fetch (como um endpoint HTTP real receberia), recomputa HMAC-SHA256(PLAINTEXT, `${ts}.${body}`)
// de forma independente do módulo signature.js, e confere que bate com o header enviado.
describe('deliverBatch — assinatura é verificável pelo receptor com o PLAINTEXT (regressão C1)', () => {
  it('receptor recomputa HMAC-SHA256(plaintext, timestamp.rawBody) e bate com X-Sentinela-Signature', async () => {
    process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';

    let receivedHeaders = null;
    let receivedBody = null;
    const fetchImpl = async (_url, init) => {
      receivedHeaders = init.headers;
      receivedBody = init.body;
      return { status: 200, headers: fakeHeaders() };
    };

    const rawBody = JSON.stringify({ schema_version: 1, batch: { id: 1 }, messages: [] });
    const timestamp = '1700000000';
    const result = await deliverBatch(baseArgs({ fetchImpl, rawBody, timestamp, secretPlaintext: SECRET }));

    expect(result.status).toBe('success');
    expect(receivedBody).toBe(rawBody); // a assinatura deve cobrir EXATAMENTE o corpo enviado

    const signatureHeader = receivedHeaders['X-Sentinela-Signature'];
    expect(signatureHeader).toMatch(/^sha256=/);

    // Receptor: só tem o PLAINTEXT (o mesmo que o admin copiou da UI) — nunca o hash/cifrado.
    const receiverExpectedHex = createHmac('sha256', SECRET)
      .update(`${timestamp}.${rawBody}`, 'utf8')
      .digest('hex');
    const providedHex = signatureHeader.slice('sha256='.length);

    const provided = Buffer.from(providedHex, 'hex');
    const expected = Buffer.from(receiverExpectedHex, 'hex');
    expect(provided.length).toBe(expected.length);
    expect(timingSafeEqual(provided, expected)).toBe(true);
  });
});

describe('runWithRetries', () => {
  it('sucesso na primeira tentativa: não repete, attempts=1', async () => {
    process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return { status: 200, headers: fakeHeaders() }; };

    const result = await runWithRetries(baseArgs({ fetchImpl }));

    expect(result.status).toBe('success');
    expect(calls).toBe(1);
    expect(result.attempts).toBe(1);
  });

  it('gate desligado: não repete (resultado não muda entre tentativas)', async () => {
    delete process.env.EXTERNAL_INTEGRATIONS_ENABLED;
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return { status: 200, headers: fakeHeaders() }; };

    const result = await runWithRetries(baseArgs({ fetchImpl, maxAttempts: 5 }));

    expect(calls).toBe(0);
    expect(result.status).toBe('failure');
    expect(result.error).toBe('EXTERNAL_INTEGRATIONS_DISABLED');
    expect(result.attempts).toBe(1);
  });

  it('falha persistente: tenta até maxAttempts e reporta cada tentativa via recordAttempt', async () => {
    process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return { status: 500, headers: fakeHeaders() }; };
    const recorded = [];

    const result = await runWithRetries(baseArgs({
      fetchImpl, maxAttempts: 3, recordAttempt: async (a) => { recorded.push(a); },
    }));

    expect(calls).toBe(3);
    expect(result.status).toBe('failure');
    expect(result.attempts).toBe(3);
    expect(recorded).toHaveLength(3);
    expect(recorded.map((r) => r.attemptNo)).toEqual([1, 2, 3]);
    expect(recorded.every((r) => r.error === 'HTTP_500')).toBe(true);
  });
});

describe('repo.createBatch — idempotência', () => {
  it('duplicado com a mesma idempotency_key retorna o MESMO id, created:false, só 1 linha', async () => {
    await withTx(async (conn) => {
      await conn.query("INSERT INTO tenants (id, name, status) VALUES (910001, 'T-batch', 'active')");
      await conn.query(`INSERT INTO tenant_integrations (id, tenant_id, type, active, target_url)
        VALUES (910001, 910001, 'webhook_batch', 1, 'https://example.com/hook')`);

      const params = {
        tenantId: 910001, integrationId: 910001, schemaVersion: 1,
        windowStart: '2026-07-20 00:00:00', windowEnd: '2026-07-21 00:00:00',
        part: 1, partTotal: 1, idempotencyKey: 'idem-dup-key-1',
        conversationCount: 2, messageCount: 5,
        ...minimalSnapshotParams(),
      };

      const first = await createBatch(conn, params);
      const second = await createBatch(conn, params);

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.id).toBe(first.id);

      const [rows] = await conn.query(
        'SELECT COUNT(*) AS c FROM integration_delivery_batches WHERE idempotency_key = ?',
        ['idem-dup-key-1'],
      );
      expect(rows[0].c).toBe(1);
    });
  });

  it('mesma janela (uq_batch_window) com idempotency_key DIFERENTE retorna created:false, MESMO id, sem sobrescrever dados da 1ª chamada', async () => {
    await withTx(async (conn) => {
      await conn.query("INSERT INTO tenants (id, name, status) VALUES (910002, 'T-batch-window', 'active')");
      await conn.query(`INSERT INTO tenant_integrations (id, tenant_id, type, active, target_url)
        VALUES (910002, 910002, 'webhook_batch', 1, 'https://example.com/hook')`);

      const windowTuple = {
        tenantId: 910002, integrationId: 910002, schemaVersion: 1,
        windowStart: '2026-07-20 00:00:00', windowEnd: '2026-07-21 00:00:00', part: 1,
      };

      const first = await createBatch(conn, {
        ...windowTuple, partTotal: 1, idempotencyKey: 'idem-window-key-A',
        conversationCount: 2, messageCount: 5,
        ...minimalSnapshotParams({ marker: 'A' }),
      });
      const second = await createBatch(conn, {
        ...windowTuple, partTotal: 9, idempotencyKey: 'idem-window-key-B',
        conversationCount: 99, messageCount: 999,
        ...minimalSnapshotParams({ marker: 'B' }),
      });

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.id).toBe(first.id);

      const [rows] = await conn.query(
        `SELECT COUNT(*) AS c FROM integration_delivery_batches
         WHERE tenant_id = ? AND integration_id = ? AND window_start = ? AND window_end = ?
           AND schema_version = ? AND part = ?`,
        [windowTuple.tenantId, windowTuple.integrationId, windowTuple.windowStart,
          windowTuple.windowEnd, windowTuple.schemaVersion, windowTuple.part],
      );
      expect(rows[0].c).toBe(1);

      const [stored] = await conn.query(
        'SELECT idempotency_key, part_total, message_count, conversation_count FROM integration_delivery_batches WHERE id = ?',
        [first.id],
      );
      expect(stored[0].idempotency_key).toBe('idem-window-key-A');
      expect(stored[0].part_total).toBe(1);
      expect(stored[0].message_count).toBe(5);
      expect(stored[0].conversation_count).toBe(2);
    });
  });
});

describe('repo.createBatch — snapshot imutável (Etapa B, S2)', () => {
  it('persiste todas as colunas de snapshot no INSERT', async () => {
    await withTx(async (conn) => {
      await conn.query("INSERT INTO tenants (id, name, status) VALUES (910010, 'T-snap', 'active')");
      await conn.query(`INSERT INTO tenant_integrations (id, tenant_id, type, active, target_url)
        VALUES (910010, 910010, 'webhook_batch', 1, 'https://example.com/hook')`);

      const rawBody = JSON.stringify({ schema_version: 1, batch: { part: 1 }, messages: [{ x: 1 }] });
      const snap = encodeSnapshot(rawBody);

      const { id } = await createBatch(conn, {
        tenantId: 910010, integrationId: 910010, schemaVersion: 1,
        windowStart: '2026-07-20 00:00:00', windowEnd: '2026-07-21 00:00:00',
        part: 1, partTotal: 1, idempotencyKey: 'idem-snap-1',
        conversationCount: 1, messageCount: 1,
        payloadCompressed: snap.compressed, payloadSha256: snap.sha256,
        payloadSizeBytes: snap.sizeBytes, payloadEncoding: snap.encoding,
        targetUrlSnapshot: 'https://example.com/hook',
        contentOptionsSnapshot: { include_direct: true, include_groups: false, include_from_me: true, include_audio_transcripts: false },
      });

      const [rows] = await conn.query(
        `SELECT payload_compressed, payload_sha256, payload_size_bytes, payload_encoding,
                payload_created_at, target_url_snapshot, content_options_snapshot
         FROM integration_delivery_batches WHERE id = ?`,
        [id],
      );
      const row = rows[0];
      expect(row.payload_compressed).not.toBeNull();
      expect(row.payload_sha256).toBe(snap.sha256);
      expect(row.payload_size_bytes).toBe(snap.sizeBytes);
      expect(row.payload_encoding).toBe('gzip');
      expect(row.payload_created_at).not.toBeNull();
      expect(row.target_url_snapshot).toBe('https://example.com/hook');
      const opts = typeof row.content_options_snapshot === 'string'
        ? JSON.parse(row.content_options_snapshot) : row.content_options_snapshot;
      expect(opts).toEqual({ include_direct: true, include_groups: false, include_from_me: true, include_audio_transcripts: false });
    });
  });

  it('segunda chamada (mesma idempotency_key) com bytes DIFERENTES retorna created:false e NÃO sobrescreve o snapshot original', async () => {
    await withTx(async (conn) => {
      await conn.query("INSERT INTO tenants (id, name, status) VALUES (910011, 'T-snap-dup', 'active')");
      await conn.query(`INSERT INTO tenant_integrations (id, tenant_id, type, active, target_url)
        VALUES (910011, 910011, 'webhook_batch', 1, 'https://example.com/hook')`);

      const firstSnap = encodeSnapshot(JSON.stringify({ version: 'original' }));
      const secondSnap = encodeSnapshot(JSON.stringify({ version: 'DIFERENTE — nunca deveria substituir' }));

      const base = {
        tenantId: 910011, integrationId: 910011, schemaVersion: 1,
        windowStart: '2026-07-20 00:00:00', windowEnd: '2026-07-21 00:00:00',
        part: 1, partTotal: 1, idempotencyKey: 'idem-snap-dup-1',
        conversationCount: 1, messageCount: 1, targetUrlSnapshot: 'https://example.com/hook',
      };

      const first = await createBatch(conn, {
        ...base,
        payloadCompressed: firstSnap.compressed, payloadSha256: firstSnap.sha256,
        payloadSizeBytes: firstSnap.sizeBytes, payloadEncoding: firstSnap.encoding,
      });
      const second = await createBatch(conn, {
        ...base,
        payloadCompressed: secondSnap.compressed, payloadSha256: secondSnap.sha256,
        payloadSizeBytes: secondSnap.sizeBytes, payloadEncoding: secondSnap.encoding,
      });

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.id).toBe(first.id);

      const [rows] = await conn.query(
        'SELECT payload_sha256 FROM integration_delivery_batches WHERE id = ?', [first.id],
      );
      expect(rows[0].payload_sha256).toBe(firstSnap.sha256);
      expect(rows[0].payload_sha256).not.toBe(secondSnap.sha256);
    });
  });

  it('createBatch sem snapshot lança PAYLOAD_SNAPSHOT_REQUIRED (nunca cria batch usável sem corpo)', async () => {
    await withTx(async (conn) => {
      await conn.query("INSERT INTO tenants (id, name, status) VALUES (910012, 'T-snap-missing', 'active')");
      await conn.query(`INSERT INTO tenant_integrations (id, tenant_id, type, active, target_url)
        VALUES (910012, 910012, 'webhook_batch', 1, 'https://example.com/hook')`);

      await expect(createBatch(conn, {
        tenantId: 910012, integrationId: 910012, schemaVersion: 1,
        windowStart: '2026-07-20 00:00:00', windowEnd: '2026-07-21 00:00:00',
        part: 1, partTotal: 1, idempotencyKey: 'idem-snap-missing-1',
        conversationCount: 0, messageCount: 0,
      })).rejects.toThrow('PAYLOAD_SNAPSHOT_REQUIRED');
    });
  });

  it('batch existente com payload_compressed adulterado no banco: createBatch duplicado lança PAYLOAD_INTEGRITY', async () => {
    await withTx(async (conn) => {
      await conn.query("INSERT INTO tenants (id, name, status) VALUES (910013, 'T-snap-tamper', 'active')");
      await conn.query(`INSERT INTO tenant_integrations (id, tenant_id, type, active, target_url)
        VALUES (910013, 910013, 'webhook_batch', 1, 'https://example.com/hook')`);

      const snap = encodeSnapshot(JSON.stringify({ version: 'original' }));
      const params = {
        tenantId: 910013, integrationId: 910013, schemaVersion: 1,
        windowStart: '2026-07-20 00:00:00', windowEnd: '2026-07-21 00:00:00',
        part: 1, partTotal: 1, idempotencyKey: 'idem-snap-tamper-1',
        conversationCount: 0, messageCount: 0,
        payloadCompressed: snap.compressed, payloadSha256: snap.sha256,
        payloadSizeBytes: snap.sizeBytes, payloadEncoding: snap.encoding,
        targetUrlSnapshot: 'https://example.com/hook',
      };
      const first = await createBatch(conn, params);

      // Simula adulteração/corrupção direta no banco (bypass da aplicação).
      await conn.query(
        'UPDATE integration_delivery_batches SET payload_compressed = ? WHERE id = ?',
        [Buffer.from('garbage-not-gzip'), first.id],
      );

      await expect(createBatch(conn, params)).rejects.toThrow('PAYLOAD_INTEGRITY');
    });
  });
});

describe('repo.loadBatchSnapshot', () => {
  it('retorna o rawBody exato + target_url_snapshot persistidos', async () => {
    await withTx(async (conn) => {
      await conn.query("INSERT INTO tenants (id, name, status) VALUES (910020, 'T-loadsnap', 'active')");
      await conn.query(`INSERT INTO tenant_integrations (id, tenant_id, type, active, target_url)
        VALUES (910020, 910020, 'webhook_batch', 1, 'https://example.com/hook')`);

      const rawBody = JSON.stringify({ schema_version: 1, batch: { part: 1 }, messages: [{ hello: 'snapshot' }] });
      const snap = encodeSnapshot(rawBody);
      const { id } = await createBatch(conn, {
        tenantId: 910020, integrationId: 910020, schemaVersion: 1,
        windowStart: '2026-07-20 00:00:00', windowEnd: '2026-07-21 00:00:00',
        part: 1, partTotal: 1, idempotencyKey: 'idem-loadsnap-1',
        conversationCount: 0, messageCount: 1,
        payloadCompressed: snap.compressed, payloadSha256: snap.sha256,
        payloadSizeBytes: snap.sizeBytes, payloadEncoding: snap.encoding,
        targetUrlSnapshot: 'https://target-snapshot.example.com/hook',
      });

      const loaded = await loadBatchSnapshot(conn, id);
      expect(loaded.rawBody).toBe(rawBody);
      expect(loaded.targetUrl).toBe('https://target-snapshot.example.com/hook');
      expect(loaded.sha256).toBe(snap.sha256);
      expect(loaded.sizeBytes).toBe(snap.sizeBytes);
    });
  });

  it('batch SEM snapshot (colunas NULL) é não-entregável: lança PAYLOAD_INTEGRITY', async () => {
    await withTx(async (conn) => {
      await conn.query("INSERT INTO tenants (id, name, status) VALUES (910021, 'T-nosnap', 'active')");
      await conn.query(`INSERT INTO tenant_integrations (id, tenant_id, type, active, target_url)
        VALUES (910021, 910021, 'webhook_batch', 1, 'https://example.com/hook')`);
      const [ins] = await conn.query(
        `INSERT INTO integration_delivery_batches
           (tenant_id, integration_id, schema_version, window_start, window_end, part, part_total,
            idempotency_key, status, conversation_count, message_count)
         VALUES (910021, 910021, 1, '2026-07-20 00:00:00', '2026-07-21 00:00:00', 1, 1, 'idem-nosnap-1', 'pending', 0, 0)`,
      );

      await expect(loadBatchSnapshot(conn, ins.insertId)).rejects.toThrow('PAYLOAD_INTEGRITY');
    });
  });

  it('payload_sha256 adulterado no banco: loadBatchSnapshot lança PAYLOAD_INTEGRITY (não entrega)', async () => {
    await withTx(async (conn) => {
      await conn.query("INSERT INTO tenants (id, name, status) VALUES (910022, 'T-tamper-load', 'active')");
      await conn.query(`INSERT INTO tenant_integrations (id, tenant_id, type, active, target_url)
        VALUES (910022, 910022, 'webhook_batch', 1, 'https://example.com/hook')`);

      const snap = encodeSnapshot(JSON.stringify({ a: 1 }));
      const { id } = await createBatch(conn, {
        tenantId: 910022, integrationId: 910022, schemaVersion: 1,
        windowStart: '2026-07-20 00:00:00', windowEnd: '2026-07-21 00:00:00',
        part: 1, partTotal: 1, idempotencyKey: 'idem-tamper-load-1',
        conversationCount: 0, messageCount: 0,
        payloadCompressed: snap.compressed, payloadSha256: snap.sha256,
        payloadSizeBytes: snap.sizeBytes, payloadEncoding: snap.encoding,
      });

      await conn.query(
        'UPDATE integration_delivery_batches SET payload_sha256 = ? WHERE id = ?',
        ['0'.repeat(64), id],
      );

      await expect(loadBatchSnapshot(conn, id)).rejects.toThrow('PAYLOAD_INTEGRITY');
    });
  });
});

describe('repo.listBatches / repo.getBatch — nunca expõem payload_compressed', () => {
  it('listBatches: as linhas retornadas não têm a chave payload_compressed', async () => {
    await withTx(async (conn) => {
      await conn.query("INSERT INTO tenants (id, name, status) VALUES (910030, 'T-listing', 'active')");
      await conn.query(`INSERT INTO tenant_integrations (id, tenant_id, type, active, target_url)
        VALUES (910030, 910030, 'webhook_batch', 1, 'https://example.com/hook')`);

      const snap = encodeSnapshot(JSON.stringify({ a: 'listing-test' }));
      await createBatch(conn, {
        tenantId: 910030, integrationId: 910030, schemaVersion: 1,
        windowStart: '2026-07-20 00:00:00', windowEnd: '2026-07-21 00:00:00',
        part: 1, partTotal: 1, idempotencyKey: 'idem-listing-1',
        conversationCount: 0, messageCount: 0,
        payloadCompressed: snap.compressed, payloadSha256: snap.sha256,
        payloadSizeBytes: snap.sizeBytes, payloadEncoding: snap.encoding,
      });

      const { rows } = await listBatches(conn, 910030, { page: 1, limit: 20 });
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(Object.prototype.hasOwnProperty.call(row, 'payload_compressed')).toBe(false);
      }
      expect(JSON.stringify(rows)).not.toMatch(/listing-test/);
    });
  });

  it('getBatch: a linha retornada não tem a chave payload_compressed', async () => {
    await withTx(async (conn) => {
      await conn.query("INSERT INTO tenants (id, name, status) VALUES (910031, 'T-getbatch', 'active')");
      await conn.query(`INSERT INTO tenant_integrations (id, tenant_id, type, active, target_url)
        VALUES (910031, 910031, 'webhook_batch', 1, 'https://example.com/hook')`);

      const snap = encodeSnapshot(JSON.stringify({ a: 'getbatch-test' }));
      const { id } = await createBatch(conn, {
        tenantId: 910031, integrationId: 910031, schemaVersion: 1,
        windowStart: '2026-07-20 00:00:00', windowEnd: '2026-07-21 00:00:00',
        part: 1, partTotal: 1, idempotencyKey: 'idem-getbatch-1',
        conversationCount: 0, messageCount: 0,
        payloadCompressed: snap.compressed, payloadSha256: snap.sha256,
        payloadSizeBytes: snap.sizeBytes, payloadEncoding: snap.encoding,
      });

      const row = await getBatch(conn, 910031, id);
      expect(row).not.toBeNull();
      expect(Object.prototype.hasOwnProperty.call(row, 'payload_compressed')).toBe(false);
      expect(JSON.stringify(row)).not.toMatch(/getbatch-test/);
      // metadata de snapshot (não o corpo) continua presente:
      expect(row.payload_sha256).toBe(snap.sha256);
    });
  });
});

describe('repo.loadWindowData — isolamento tenant + include_groups', () => {
  async function seedTwoTenants(conn) {
    await conn.query("INSERT INTO tenants (id, name, status) VALUES (920001,'TA','active'),(920002,'TB','active')");
    await conn.query(`INSERT INTO chats (id, tenant_id, title, is_group) VALUES
      ('chA-direct', 920001, NULL, 0),
      ('chA-group', 920001, 'Grupo A', 1),
      ('chB-direct', 920002, NULL, 0)`);
    await conn.query(`INSERT INTO messages (id, tenant_id, chat_id, text, type, from_me, from_internal, timestamp) VALUES
      ('mA1', 920001, 'chA-direct', 'oi de A', 'text', 0, 0, '2026-07-20 10:00:00'),
      ('mA2', 920001, 'chA-group', 'grupo de A', 'text', 0, 0, '2026-07-20 10:05:00'),
      ('mB1', 920002, 'chB-direct', 'oi de B - nao deve vazar', 'text', 0, 0, '2026-07-20 10:10:00')`);
  }

  const window = { start: new Date('2026-07-20T00:00:00Z'), end: new Date('2026-07-21T00:00:00Z') };

  it('retorna só as linhas do tenantId passado (sem cross-tenant)', async () => {
    await withTx(async (conn) => {
      await seedTwoTenants(conn);
      const integration = { include_direct: 1, include_groups: 1, include_from_me: 1, include_audio_transcripts: 0 };

      const dataA = await loadWindowData(conn, 920001, integration, window);
      expect(dataA.messages.every((m) => ['chA-direct', 'chA-group'].includes(m.chat_id))).toBe(true);
      expect(JSON.stringify(dataA)).not.toMatch(/oi de B/);
      expect(dataA.messages).toHaveLength(2);

      const dataB = await loadWindowData(conn, 920002, integration, window);
      expect(dataB.messages).toHaveLength(1);
      expect(dataB.messages[0].chat_id).toBe('chB-direct');
    });
  });

  it('include_groups=false exclui mensagens de chat de grupo', async () => {
    await withTx(async (conn) => {
      await seedTwoTenants(conn);
      const integration = { include_direct: 1, include_groups: 0, include_from_me: 1, include_audio_transcripts: 0 };

      const data = await loadWindowData(conn, 920001, integration, window);

      expect(data.messages).toHaveLength(1);
      expect(data.messages[0].chat_id).toBe('chA-direct');
      expect(data.conversations.every((c) => c.is_group === false)).toBe(true);
    });
  });
});

// ---- Etapa B, S3 — entrega usa o snapshot imutável (attemptBatchDelivery NUNCA reconstrói) ----
//
// Ver docs/superpowers/plans/2026-07-28-etapaB-payload-snapshot.md, seção "Testes obrigatórios".
// Estes testes montam um batch da MESMA forma que o job faria (loadWindowData -> buildPayload ->
// chunkPayload -> encodeSnapshot -> createBatch), depois exercitam `attemptBatchDelivery`
// diretamente (o helper compartilhado job/resend) capturando os bytes exatos enviados via
// `fetchImpl`, para provar que retry/reenvio nunca recalculam o corpo a partir do banco.

const SNAP_SECRET_KEY_HEX = '4'.repeat(64);
const SNAP_SECRET_KEY = Buffer.from(SNAP_SECRET_KEY_HEX, 'hex');

function snapCurrentKey() {
  const raw = process.env.INTEGRATIONS_SECRET_KEY || SNAP_SECRET_KEY_HEX;
  return /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
}

// Cria tenant + integração + UM batch real (snapshot construído a partir de mensagens de verdade
// no banco), igual ao que `createDueBatches` (job) faz. Retorna { batch, integration, tenantId }.
async function seedRealSnapshotBatch(conn, {
  tenantId, integrationId, messages, targetUrl = 'https://example.com/webhook', withSecret = true,
  includeAudioTranscripts = 0,
}) {
  await conn.query("INSERT INTO tenants (id, name, status) VALUES (?, ?, 'active')", [tenantId, `T-${tenantId}`]);
  const secretEncrypted = withSecret ? encryptSecret(`whsec_snap-${integrationId}`, snapCurrentKey()) : null;
  await conn.query(
    `INSERT INTO tenant_integrations
       (id, tenant_id, type, active, target_url, secret_encrypted, secret_masked, frequency, run_at_time, timezone,
        include_direct, include_groups, include_from_me, include_audio_transcripts)
     VALUES (?, ?, 'webhook_batch', 1, ?, ?, 'whsec_••••fake', 'daily', '03:00', 'America/Sao_Paulo', 1, 1, 1, ?)`,
    [integrationId, tenantId, targetUrl, secretEncrypted, includeAudioTranscripts],
  );
  await conn.query(
    `INSERT INTO chats (id, tenant_id, title, is_group) VALUES (?, ?, NULL, 0)`,
    [`chat-${integrationId}`, tenantId],
  );
  for (const m of messages) {
    // eslint-disable-next-line no-await-in-loop
    await conn.query(
      `INSERT INTO messages (id, tenant_id, chat_id, text, type, from_me, from_internal, timestamp)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?)`,
      [m.id, tenantId, `chat-${integrationId}`, m.text, m.type || 'text', m.timestamp],
    );
  }

  const [[cfg]] = await conn.query(
    'SELECT * FROM tenant_integrations WHERE id = ? AND tenant_id = ?', [integrationId, tenantId],
  );
  const window = { start: new Date('2026-07-20T00:00:00Z'), end: new Date('2026-07-21T00:00:00Z') };
  const { conversations, messages: loadedMessages } = await loadWindowData(conn, tenantId, cfg, window);
  const fullPayload = buildPayload({
    tenant: { id: tenantId }, integration: cfg, window, conversations, messages: loadedMessages, schemaVersion: 1,
  });
  const parts = chunkPayload(fullPayload, {});
  const part = parts[0];
  const rawBody = JSON.stringify(part);
  const snap = encodeSnapshot(rawBody);
  const key = idempotencyKey({
    tenantId, integrationId, windowStart: window.start, windowEnd: window.end, schemaVersion: 1, part: part.batch.part,
  });

  const { id } = await createBatch(conn, {
    tenantId, integrationId, schemaVersion: 1, windowStart: window.start, windowEnd: window.end,
    part: part.batch.part, partTotal: part.batch.part_total, idempotencyKey: key,
    conversationCount: part.conversations.length, messageCount: part.messages.length,
    initialStatus: 'pending',
    payloadCompressed: snap.compressed, payloadSha256: snap.sha256,
    payloadSizeBytes: snap.sizeBytes, payloadEncoding: snap.encoding,
    targetUrlSnapshot: cfg.target_url,
    contentOptionsSnapshot: {
      include_direct: !!cfg.include_direct, include_groups: !!cfg.include_groups,
      include_from_me: !!cfg.include_from_me, include_audio_transcripts: !!cfg.include_audio_transcripts,
    },
  });
  const [[batch]] = await conn.query('SELECT * FROM integration_delivery_batches WHERE id = ?', [id]);
  return { batch, integration: cfg, tenantId, rawBody };
}

async function claimAndAttempt(conn, { tenantId, integration, batch, now, fetchImpl, auditAction = 'deliver_integration' }) {
  const claim = await claimBatchForAttempt(conn, batch.id, { now, includeBlocked: true });
  expect(claim.claimed).toBe(true);
  const [[freshBatch]] = await conn.query('SELECT * FROM integration_delivery_batches WHERE id = ?', [batch.id]);
  return attemptBatchDelivery(conn, {
    tenantId, integration, batch: freshBatch, now, secretKey: snapCurrentKey(), allowHttp: true,
    fetchImpl, deliveryIdPrefix: 'test', auditAction,
  });
}

describe('attemptBatchDelivery — usa o snapshot imutável (Etapa B, S3)', () => {
  it('1. retry usa os MESMOS bytes da 1ª tentativa', async () => {
    await withTx(async (conn) => {
      process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
      const tenantId = 940001;
      const seeded = await seedRealSnapshotBatch(conn, {
        tenantId, integrationId: tenantId,
        messages: [{ id: 'm1', text: 'ola', timestamp: '2026-07-20 10:00:00' }],
      });

      const bodies = [];
      const failThenSucceed = async (_url, init) => {
        bodies.push(init.body);
        return bodies.length === 1
          ? { status: 500, headers: fakeHeaders() }
          : { status: 200, headers: fakeHeaders() };
      };

      const first = await claimAndAttempt(conn, {
        tenantId, integration: seeded.integration, batch: seeded.batch, now: new Date('2026-07-22T00:00:00Z'), fetchImpl: failThenSucceed,
      });
      expect(first.attemptStatus).toBe('pending_retry');

      const second = await claimAndAttempt(conn, {
        tenantId, integration: seeded.integration, batch: seeded.batch, now: new Date('2026-07-22T01:00:00Z'), fetchImpl: failThenSucceed,
      });
      expect(second.attemptStatus).toBe('delivered');

      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toBe(bodies[1]);
      expect(bodies[0]).toBe(seeded.rawBody);
    });
  });

  it('2. mensagem ALTERADA após criação do batch NÃO muda o corpo do retry', async () => {
    await withTx(async (conn) => {
      process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
      const tenantId = 940002;
      const seeded = await seedRealSnapshotBatch(conn, {
        tenantId, integrationId: tenantId,
        messages: [{ id: 'm1', text: 'texto original', timestamp: '2026-07-20 10:00:00' }],
      });

      await conn.query("UPDATE messages SET text = 'TEXTO ALTERADO DEPOIS' WHERE id = 'm1'");

      let capturedBody = null;
      const fetchImpl = async (_url, init) => { capturedBody = init.body; return { status: 200, headers: fakeHeaders() }; };
      const result = await claimAndAttempt(conn, {
        tenantId, integration: seeded.integration, batch: seeded.batch, now: new Date('2026-07-22T00:00:00Z'), fetchImpl,
      });

      expect(result.attemptStatus).toBe('delivered');
      expect(capturedBody).toBe(seeded.rawBody);
      expect(capturedBody).not.toMatch(/TEXTO ALTERADO DEPOIS/);
      expect(capturedBody).toMatch(/texto original/);
    });
  });

  it('3. mensagem EXCLUÍDA após criação do batch NÃO muda o corpo do retry', async () => {
    await withTx(async (conn) => {
      process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
      const tenantId = 940003;
      const seeded = await seedRealSnapshotBatch(conn, {
        tenantId, integrationId: tenantId,
        messages: [{ id: 'm1', text: 'vai ser apagada', timestamp: '2026-07-20 10:00:00' }],
      });

      await conn.query("DELETE FROM messages WHERE id = 'm1'");

      let capturedBody = null;
      const fetchImpl = async (_url, init) => { capturedBody = init.body; return { status: 200, headers: fakeHeaders() }; };
      const result = await claimAndAttempt(conn, {
        tenantId, integration: seeded.integration, batch: seeded.batch, now: new Date('2026-07-22T00:00:00Z'), fetchImpl,
      });

      expect(result.attemptStatus).toBe('delivered');
      expect(capturedBody).toBe(seeded.rawBody);
      expect(capturedBody).toMatch(/vai ser apagada/);
    });
  });

  it('4. transcrição ADICIONADA depois da criação NÃO muda o corpo do retry', async () => {
    await withTx(async (conn) => {
      process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
      const tenantId = 940004;
      const seeded = await seedRealSnapshotBatch(conn, {
        tenantId, integrationId: tenantId,
        messages: [{ id: 'm1', text: 'oi', timestamp: '2026-07-20 10:00:00' }],
        includeAudioTranscripts: 0,
      });

      // "Transcrição tardia": um áudio novo (nunca existia no momento da criação do batch).
      await conn.query(
        `INSERT INTO messages (id, tenant_id, chat_id, text, type, from_me, from_internal, timestamp)
         VALUES ('m2-audio', ?, ?, 'transcricao tardia', 'audio', 0, 0, '2026-07-20 10:05:00')`,
        [tenantId, `chat-${tenantId}`],
      );

      let capturedBody = null;
      const fetchImpl = async (_url, init) => { capturedBody = init.body; return { status: 200, headers: fakeHeaders() }; };
      const result = await claimAndAttempt(conn, {
        tenantId, integration: seeded.integration, batch: seeded.batch, now: new Date('2026-07-22T00:00:00Z'), fetchImpl,
      });

      expect(result.attemptStatus).toBe('delivered');
      expect(capturedBody).toBe(seeded.rawBody);
      expect(capturedBody).not.toMatch(/transcricao tardia/);
    });
  });

  it('5. config de inclusão de conteúdo alterada depois NÃO muda o payload do batch já criado', async () => {
    await withTx(async (conn) => {
      process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
      const tenantId = 940005;
      const seeded = await seedRealSnapshotBatch(conn, {
        tenantId, integrationId: tenantId,
        messages: [{ id: 'm1', text: 'oi', timestamp: '2026-07-20 10:00:00' }],
      });

      // Muda a config da integração (ex.: desliga include_from_me) DEPOIS do batch criado.
      await conn.query('UPDATE tenant_integrations SET include_from_me = 0 WHERE id = ?', [tenantId]);
      const [[updatedCfg]] = await conn.query('SELECT * FROM tenant_integrations WHERE id = ?', [tenantId]);

      let capturedBody = null;
      const fetchImpl = async (_url, init) => { capturedBody = init.body; return { status: 200, headers: fakeHeaders() }; };
      const result = await claimAndAttempt(conn, {
        tenantId, integration: updatedCfg, batch: seeded.batch, now: new Date('2026-07-22T00:00:00Z'), fetchImpl,
      });

      expect(result.attemptStatus).toBe('delivered');
      expect(capturedBody).toBe(seeded.rawBody);
    });
  });

  it('6. chunking diferente aplicado depois não altera a parte já persistida', async () => {
    await withTx(async (conn) => {
      process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
      const tenantId = 940006;
      const seeded = await seedRealSnapshotBatch(conn, {
        tenantId, integrationId: tenantId,
        messages: [
          { id: 'm1', text: 'a', timestamp: '2026-07-20 10:00:00' },
          { id: 'm2', text: 'b', timestamp: '2026-07-20 10:01:00' },
        ],
      });

      // Simula uma execução posterior que usaria um chunking bem diferente (maxMessages:1) — isso
      // NUNCA deve afetar o batch/parte já persistidos, pois attemptBatchDelivery não rechunk.
      let capturedBody = null;
      const fetchImpl = async (_url, init) => { capturedBody = init.body; return { status: 200, headers: fakeHeaders() }; };
      const result = await claimAndAttempt(conn, {
        tenantId, integration: seeded.integration, batch: seeded.batch, now: new Date('2026-07-22T00:00:00Z'), fetchImpl,
      });

      expect(result.attemptStatus).toBe('delivered');
      expect(capturedBody).toBe(seeded.rawBody);
      expect(JSON.parse(capturedBody).messages).toHaveLength(2);
    });
  });

  it('7. a mesma idempotency_key sempre corresponde ao mesmo payload_sha256', async () => {
    await withTx(async (conn) => {
      process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
      const tenantId = 940007;
      const seeded = await seedRealSnapshotBatch(conn, {
        tenantId, integrationId: tenantId,
        messages: [{ id: 'm1', text: 'oi', timestamp: '2026-07-20 10:00:00' }],
      });
      const expectedSha = encodeSnapshot(seeded.rawBody).sha256;

      const [[row1]] = await conn.query(
        'SELECT payload_sha256 FROM integration_delivery_batches WHERE idempotency_key = ?', [seeded.batch.idempotency_key],
      );
      expect(row1.payload_sha256).toBe(expectedSha);

      // Uma segunda "tentativa de criação" com a mesma idempotency_key (ex.: reprocessamento do
      // job) nunca substitui o snapshot nem produz um sha diferente.
      const dup = await createBatch(conn, {
        tenantId, integrationId: tenantId, schemaVersion: 1,
        windowStart: seeded.batch.window_start, windowEnd: seeded.batch.window_end, part: seeded.batch.part,
        partTotal: seeded.batch.part_total, idempotencyKey: seeded.batch.idempotency_key,
        conversationCount: 0, messageCount: 0,
        ...encodeSnapshot(JSON.stringify({ different: true })),
        payloadCompressed: encodeSnapshot(JSON.stringify({ different: true })).compressed,
        payloadSha256: encodeSnapshot(JSON.stringify({ different: true })).sha256,
        payloadSizeBytes: encodeSnapshot(JSON.stringify({ different: true })).sizeBytes,
        payloadEncoding: encodeSnapshot(JSON.stringify({ different: true })).encoding,
      });
      expect(dup.created).toBe(false);
      const [[row2]] = await conn.query(
        'SELECT payload_sha256 FROM integration_delivery_batches WHERE idempotency_key = ?', [seeded.batch.idempotency_key],
      );
      expect(row2.payload_sha256).toBe(expectedSha);
    });
  });

  it('8. payload adulterado no banco é detectado e NÃO enviado (PAYLOAD_INTEGRITY, fetch nunca chamado)', async () => {
    await withTx(async (conn) => {
      process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
      const tenantId = 940008;
      const seeded = await seedRealSnapshotBatch(conn, {
        tenantId, integrationId: tenantId,
        messages: [{ id: 'm1', text: 'oi', timestamp: '2026-07-20 10:00:00' }],
      });

      await conn.query(
        'UPDATE integration_delivery_batches SET payload_compressed = ? WHERE id = ?',
        [Buffer.from('lixo-nao-e-gzip-valido'), seeded.batch.id],
      );

      let called = false;
      const fetchImpl = async () => { called = true; return { status: 200, headers: fakeHeaders() }; };
      const result = await claimAndAttempt(conn, {
        tenantId, integration: seeded.integration, batch: seeded.batch, now: new Date('2026-07-22T00:00:00Z'), fetchImpl,
      });

      expect(called).toBe(false);
      expect(result.attemptStatus).toBe('failed');
      expect(result.error).toBe('PAYLOAD_INTEGRITY');

      const [[row]] = await conn.query('SELECT status FROM integration_delivery_batches WHERE id = ?', [seeded.batch.id]);
      expect(row.status).toBe('failed'); // não-entregável: nunca fica pending_retry (não se auto-corrige)

      const [attempts] = await conn.query('SELECT * FROM integration_delivery_attempts WHERE batch_id = ?', [seeded.batch.id]);
      expect(attempts).toHaveLength(1);
      expect(attempts[0].status).toBe('failure');
      expect(attempts[0].error).toBe('PAYLOAD_INTEGRITY');
    });
  });

  it('9. batch com snapshot NULL não é enviado (PAYLOAD_INTEGRITY)', async () => {
    await withTx(async (conn) => {
      process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
      const tenantId = 940009;
      await conn.query("INSERT INTO tenants (id, name, status) VALUES (?, ?, 'active')", [tenantId, `T-${tenantId}`]);
      await conn.query(
        `INSERT INTO tenant_integrations (id, tenant_id, type, active, target_url, secret_encrypted, secret_masked)
         VALUES (?, ?, 'webhook_batch', 1, 'https://example.com/webhook', ?, 'whsec_••••fake')`,
        [tenantId, tenantId, encryptSecret('whsec_x', snapCurrentKey())],
      );
      const [ins] = await conn.query(
        `INSERT INTO integration_delivery_batches
           (tenant_id, integration_id, schema_version, window_start, window_end, part, part_total,
            idempotency_key, status, conversation_count, message_count)
         VALUES (?, ?, 1, '2026-07-20 00:00:00', '2026-07-21 00:00:00', 1, 1, 'idem-nosnap-attempt', 'pending', 0, 0)`,
        [tenantId, tenantId],
      );
      const [[cfg]] = await conn.query('SELECT * FROM tenant_integrations WHERE id = ?', [tenantId]);
      const [[batch]] = await conn.query('SELECT * FROM integration_delivery_batches WHERE id = ?', [ins.insertId]);

      let called = false;
      const fetchImpl = async () => { called = true; return { status: 200, headers: fakeHeaders() }; };
      const result = await claimAndAttempt(conn, {
        tenantId, integration: cfg, batch, now: new Date('2026-07-22T00:00:00Z'), fetchImpl,
      });

      expect(called).toBe(false);
      expect(result.attemptStatus).toBe('failed');
      expect(result.error).toBe('PAYLOAD_INTEGRITY');
    });
  });

  it('12/13. reenvio manual (auditAction resend) usa o MESMO snapshot; um redirect no meio do caminho continua assinando/enviando os mesmos bytes', async () => {
    await withTx(async (conn) => {
      process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
      const tenantId = 940012;
      const seeded = await seedRealSnapshotBatch(conn, {
        tenantId, integrationId: tenantId,
        messages: [{ id: 'm1', text: 'oi', timestamp: '2026-07-20 10:00:00' }],
      });

      const bodies = [];
      const withRedirect = async (url, init) => {
        bodies.push(init.body);
        if (bodies.length === 1) {
          return { status: 302, headers: fakeHeaders({ location: 'https://example.com/webhook-final' }) };
        }
        return { status: 200, headers: fakeHeaders() };
      };

      const result = await claimAndAttempt(conn, {
        tenantId, integration: seeded.integration, batch: seeded.batch, now: new Date('2026-07-22T00:00:00Z'),
        fetchImpl: withRedirect, auditAction: 'resend_integration_batch',
      });

      expect(result.attemptStatus).toBe('delivered');
      expect(bodies).toHaveLength(2); // 1 redirect + 1 hop final
      expect(bodies[0]).toBe(seeded.rawBody);
      expect(bodies[1]).toBe(seeded.rawBody); // o hop seguido reenvia o MESMO corpo, nunca reconstruído

      const [attemptRows] = await conn.query(
        "SELECT * FROM integration_delivery_attempts WHERE batch_id = ? AND status = 'success'", [seeded.batch.id],
      );
      expect(attemptRows).toHaveLength(1);
    });
  });

  it('14. o HMAC enviado é calculado sobre os bytes persistidos (recomputado pelo receptor bate)', async () => {
    await withTx(async (conn) => {
      process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
      const tenantId = 940014;
      const seeded = await seedRealSnapshotBatch(conn, {
        tenantId, integrationId: tenantId,
        messages: [{ id: 'm1', text: 'oi', timestamp: '2026-07-20 10:00:00' }],
      });

      let receivedHeaders = null;
      let receivedBody = null;
      let receivedTimestamp = null;
      const fetchImpl = async (_url, init) => {
        receivedHeaders = init.headers;
        receivedBody = init.body;
        receivedTimestamp = init.headers['X-Sentinela-Timestamp'];
        return { status: 200, headers: fakeHeaders() };
      };

      const result = await claimAndAttempt(conn, {
        tenantId, integration: seeded.integration, batch: seeded.batch, now: new Date('2026-07-22T00:00:00Z'), fetchImpl,
      });
      expect(result.attemptStatus).toBe('delivered');
      expect(receivedBody).toBe(seeded.rawBody);

      const secretPlaintext = `whsec_snap-${tenantId}`;
      const expectedHex = createHmac('sha256', secretPlaintext)
        .update(`${receivedTimestamp}.${receivedBody}`, 'utf8')
        .digest('hex');
      const providedHex = receivedHeaders['X-Sentinela-Signature'].slice('sha256='.length);
      expect(providedHex).toBe(expectedHex);
    });
  });

  it('a URL de entrega usada é o target_url_snapshot (não o target_url atual da integração)', async () => {
    await withTx(async (conn) => {
      process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
      const tenantId = 940015;
      const seeded = await seedRealSnapshotBatch(conn, {
        tenantId, integrationId: tenantId,
        messages: [{ id: 'm1', text: 'oi', timestamp: '2026-07-20 10:00:00' }],
        targetUrl: 'https://example.com/webhook-original',
      });

      // Config muda de URL DEPOIS do batch criado (retry deve continuar indo para a URL original).
      // Usa outro path no MESMO domínio resolvível (example.com) — o ponto do teste é a URL
      // completa usada na entrega, não a resolução DNS (fora do escopo deste teste).
      await conn.query(
        "UPDATE tenant_integrations SET target_url = 'https://example.com/webhook-novo-destino' WHERE id = ?",
        [tenantId],
      );
      const [[updatedCfg]] = await conn.query('SELECT * FROM tenant_integrations WHERE id = ?', [tenantId]);

      let receivedUrl = null;
      const fetchImpl = async (url) => { receivedUrl = url; return { status: 200, headers: fakeHeaders() }; };
      const result = await claimAndAttempt(conn, {
        tenantId, integration: updatedCfg, batch: seeded.batch, now: new Date('2026-07-22T00:00:00Z'), fetchImpl,
      });

      expect(result.attemptStatus).toBe('delivered');
      expect(receivedUrl).toBe('https://example.com/webhook-original');
    });
  });
});
