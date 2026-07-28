import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { getPool, applyMigrations, withTx } from './helpers/db.js';
import { deliverBatch, runWithRetries } from '../server/integrations/delivery.js';
import { createBatch, loadWindowData } from '../server/integrations/repo.js';

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
      });
      const second = await createBatch(conn, {
        ...windowTuple, partTotal: 9, idempotencyKey: 'idem-window-key-B',
        conversationCount: 99, messageCount: 999,
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
