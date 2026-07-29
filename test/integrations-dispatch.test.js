// Job de despacho idempotente (Etapa B — integração em lote). Testa `runDispatch` isoladamente:
// lock anti-concorrência, varredura de integrações ativas com janela vencida, criação idempotente
// de batch(es), entrega (ou não, se o gate global estiver desligado), atualização de
// `last_run_window_end`, tolerância a exceções por config (uma config ruim não derruba o job) e
// exit code coerente. `now` e `fetchImpl` são SEMPRE injetados — nunca relógio/rede reais.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { getPool, applyMigrations, withTx } from './helpers/db.js';
import { runDispatch } from '../server/jobs/dispatch-integrations.js';
import { encryptSecret } from '../server/integrations/secret.js';
import { claimBatchForAttempt } from '../server/integrations/repo.js';

const originalFlag = process.env.EXTERNAL_INTEGRATIONS_ENABLED;

const TEST_KEY_HEX = '2'.repeat(64);
const TEST_KEY = Buffer.from(TEST_KEY_HEX, 'hex');

beforeAll(async () => {
  process.env.INTEGRATIONS_SECRET_KEY = process.env.INTEGRATIONS_SECRET_KEY || TEST_KEY_HEX;
  await applyMigrations();
});
afterAll(() => getPool().end());
afterEach(() => {
  if (originalFlag === undefined) delete process.env.EXTERNAL_INTEGRATIONS_ENABLED;
  else process.env.EXTERNAL_INTEGRATIONS_ENABLED = originalFlag;
});

function fakeHeaders(map = {}) {
  return { get: (k) => map[k.toLowerCase()] ?? map[k] ?? null };
}

// now = 2026-03-11T10:00:00Z -> "hoje" local America/Sao_Paulo = 2026-03-11, dueAt 03:00 local
// = 2026-03-11T06:00:00Z (já passou); janela devida = dia local anterior (03-10)
// [2026-03-10T03:00:00Z, 2026-03-11T03:00:00Z).
const NOW = new Date('2026-03-11T10:00:00Z');

function currentTestKey() {
  const raw = process.env.INTEGRATIONS_SECRET_KEY || TEST_KEY_HEX;
  return /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
}

async function seedTenantAndIntegration(conn, {
  tenantId, integrationId, runAtTime = '03:00', active = 1, withSecret = true,
}) {
  await conn.query(
    "INSERT INTO tenants (id, name, status) VALUES (?, ?, 'active')",
    [tenantId, `T-${tenantId}`],
  );
  const secretEncrypted = withSecret
    ? encryptSecret(`whsec_test-${integrationId}`, currentTestKey())
    : null;
  await conn.query(
    `INSERT INTO tenant_integrations
       (id, tenant_id, type, active, target_url, secret_encrypted, secret_masked, frequency, run_at_time, timezone,
        include_direct, include_groups, include_from_me, include_audio_transcripts)
     VALUES (?, ?, 'webhook_batch', ?, 'https://example.com/webhook', ?, 'whsec_••••fake', 'daily', ?, 'America/Sao_Paulo', 1, 1, 1, 0)`,
    [integrationId, tenantId, active, secretEncrypted, runAtTime],
  );
}

describe('runDispatch — integração ativa vencida, gate ON, mock 200', () => {
  it('cria batch, registra tentativa de sucesso, atualiza last_run_window_end, exit 0', async () => {
    await withTx(async (conn) => {
      process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
      await seedTenantAndIntegration(conn, { tenantId: 930001, integrationId: 930001 });

      let callCount = 0;
      const fetchImpl = async () => { callCount += 1; return { status: 200, headers: fakeHeaders() }; };

      const result = await runDispatch({ pool: conn, now: NOW, fetchImpl, allowHttp: true });

      expect(result.exitCode).toBe(0);
      expect(callCount).toBe(1);

      const [batches] = await conn.query(
        'SELECT * FROM integration_delivery_batches WHERE tenant_id = ?', [930001],
      );
      expect(batches).toHaveLength(1);
      expect(batches[0].status).toBe('delivered');

      const [attempts] = await conn.query(
        'SELECT * FROM integration_delivery_attempts WHERE tenant_id = ?', [930001],
      );
      expect(attempts).toHaveLength(1);
      expect(attempts[0].status).toBe('success');

      const [cfgRows] = await conn.query(
        'SELECT last_run_window_end FROM tenant_integrations WHERE id = ?', [930001],
      );
      expect(cfgRows[0].last_run_window_end).not.toBeNull();
      expect(new Date(cfgRows[0].last_run_window_end).toISOString()).toBe('2026-03-11T03:00:00.000Z');
    });
  });

  it('segunda execução (mesma janela) não cria batch duplicado nem reentrega', async () => {
    await withTx(async (conn) => {
      process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
      await seedTenantAndIntegration(conn, { tenantId: 930002, integrationId: 930002 });

      let callCount = 0;
      const fetchImpl = async () => { callCount += 1; return { status: 200, headers: fakeHeaders() }; };

      const first = await runDispatch({ pool: conn, now: NOW, fetchImpl, allowHttp: true });
      expect(first.exitCode).toBe(0);
      expect(callCount).toBe(1);

      const second = await runDispatch({ pool: conn, now: NOW, fetchImpl, allowHttp: true });
      expect(second.exitCode).toBe(0);
      expect(callCount).toBe(1); // não chamou fetch de novo

      const [batches] = await conn.query(
        'SELECT * FROM integration_delivery_batches WHERE tenant_id = ?', [930002],
      );
      expect(batches).toHaveLength(1); // sem duplicata

      const [attempts] = await conn.query(
        'SELECT * FROM integration_delivery_attempts WHERE tenant_id = ?', [930002],
      );
      expect(attempts).toHaveLength(1); // sem reentrega
    });
  });
});

describe('runDispatch — gate OFF', () => {
  it('cria batch mas NÃO entrega (sem success falso); exit 0 (bloqueio de gate não é falha)', async () => {
    await withTx(async (conn) => {
      delete process.env.EXTERNAL_INTEGRATIONS_ENABLED;
      await seedTenantAndIntegration(conn, { tenantId: 930003, integrationId: 930003 });

      let called = false;
      const fetchImpl = async () => { called = true; return { status: 200, headers: fakeHeaders() }; };

      const result = await runDispatch({ pool: conn, now: NOW, fetchImpl, allowHttp: true });

      expect(called).toBe(false);
      expect(result.exitCode).toBe(0);

      const [batches] = await conn.query(
        'SELECT * FROM integration_delivery_batches WHERE tenant_id = ?', [930003],
      );
      expect(batches).toHaveLength(1);
      expect(batches[0].status).not.toBe('delivered');

      const [attempts] = await conn.query(
        'SELECT * FROM integration_delivery_attempts WHERE tenant_id = ?', [930003],
      );
      // Se um attempt foi gravado, deve ser failure/EXTERNAL_INTEGRATIONS_DISABLED — nunca success.
      expect(attempts.every((a) => a.status !== 'success')).toBe(true);

      // last_run_window_end é atualizado mesmo com gate OFF (janela foi processada/registrada).
      const [cfgRows] = await conn.query(
        'SELECT last_run_window_end FROM tenant_integrations WHERE id = ?', [930003],
      );
      expect(cfgRows[0].last_run_window_end).not.toBeNull();
    });
  });
});

describe('runDispatch — integração ativa vencida sem secret configurado', () => {
  it('não crasha: grava attempt failure SECRET_NOT_SET, agenda retry (retryable), janela processada, exit 0', async () => {
    // SECRET_NOT_SET é tratado como RETRYABLE (documentado em deliver-batch-attempt.js): um
    // problema operacional corrigível a qualquer momento (o tenant configura o secret na UI) não
    // deve exigir reenvio manual — o próprio retry natural do job redescobre o secret assim que
    // for configurado. Por isso o primeiro ciclo agenda pending_retry (exit 0), não falha direto.
    await withTx(async (conn) => {
      process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
      await seedTenantAndIntegration(conn, { tenantId: 930008, integrationId: 930008, withSecret: false });

      let called = false;
      const fetchImpl = async () => { called = true; return { status: 200, headers: fakeHeaders() }; };

      const result = await runDispatch({ pool: conn, now: NOW, fetchImpl, allowHttp: true });

      expect(called).toBe(false); // nunca tenta assinar/entregar sem secret
      expect(result.exitCode).toBe(0);

      const [batches] = await conn.query(
        'SELECT * FROM integration_delivery_batches WHERE tenant_id = ?', [930008],
      );
      expect(batches).toHaveLength(1);
      expect(batches[0].status).toBe('pending_retry');
      expect(batches[0].attempt_count).toBe(1);
      expect(batches[0].next_attempt_at).not.toBeNull();

      const [attempts] = await conn.query(
        'SELECT * FROM integration_delivery_attempts WHERE tenant_id = ?', [930008],
      );
      expect(attempts).toHaveLength(1);
      expect(attempts[0].status).toBe('failure');
      expect(attempts[0].error).toBe('SECRET_NOT_SET');

      // Janela ainda é marcada como processada (mesmo tratamento do gate OFF).
      const [cfgRows] = await conn.query(
        'SELECT last_run_window_end FROM tenant_integrations WHERE id = ?', [930008],
      );
      expect(cfgRows[0].last_run_window_end).not.toBeNull();
    });
  });

  it('com maxAttempts:1, esgota de imediato -> failed, exit != 0', async () => {
    await withTx(async (conn) => {
      process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
      await seedTenantAndIntegration(conn, { tenantId: 930108, integrationId: 930108, withSecret: false });

      const result = await runDispatch({
        pool: conn, now: NOW, allowHttp: true, maxAttempts: 1,
      });

      expect(result.exitCode).not.toBe(0);

      const [batches] = await conn.query(
        'SELECT * FROM integration_delivery_batches WHERE tenant_id = ?', [930108],
      );
      expect(batches[0].status).toBe('failed');
    });
  });
});

describe('runDispatch — config inválida entre várias: isola falha, continua as demais', () => {
  it('config com run_at_time inválido é pulada (log+continue); outras processam; exit != 0', async () => {
    await withTx(async (conn) => {
      process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
      await seedTenantAndIntegration(conn, { tenantId: 930004, integrationId: 930004 });
      // run_at_time inválido -> computeDueWindow lança
      await conn.query(
        "UPDATE tenant_integrations SET run_at_time = '99:99' WHERE id = 930004",
      );
      await seedTenantAndIntegration(conn, { tenantId: 930005, integrationId: 930005 });

      let callCount = 0;
      const fetchImpl = async () => { callCount += 1; return { status: 200, headers: fakeHeaders() }; };

      const result = await runDispatch({ pool: conn, now: NOW, fetchImpl, allowHttp: true });

      // a integração 930005 (válida) processou normalmente
      expect(callCount).toBe(1);
      const [batches005] = await conn.query(
        'SELECT * FROM integration_delivery_batches WHERE tenant_id = ?', [930005],
      );
      expect(batches005).toHaveLength(1);
      expect(batches005[0].status).toBe('delivered');

      // a integração 930004 (inválida) não gerou batch
      const [batches004] = await conn.query(
        'SELECT * FROM integration_delivery_batches WHERE tenant_id = ?', [930004],
      );
      expect(batches004).toHaveLength(0);

      // job não travou; exit code sinaliza que precisa de atenção (config quebrada)
      expect(result.exitCode).not.toBe(0);
    });
  });
});

describe('runDispatch — falha de entrega (mock 500)', () => {
  it('registra tentativa de falha; exit code != 0', async () => {
    await withTx(async (conn) => {
      process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
      await seedTenantAndIntegration(conn, { tenantId: 930006, integrationId: 930006 });

      const fetchImpl = async () => ({ status: 500, headers: fakeHeaders() });

      const result = await runDispatch({ pool: conn, now: NOW, fetchImpl, allowHttp: true, maxAttempts: 1 });

      expect(result.exitCode).not.toBe(0);

      const [batches] = await conn.query(
        'SELECT * FROM integration_delivery_batches WHERE tenant_id = ?', [930006],
      );
      expect(batches[0].status).toBe('failed');

      const [attempts] = await conn.query(
        'SELECT * FROM integration_delivery_attempts WHERE tenant_id = ?', [930006],
      );
      expect(attempts.length).toBeGreaterThan(0);
      expect(attempts.every((a) => a.status === 'failure')).toBe(true);
    });
  });
});

describe('runDispatch — lock anti-concorrência', () => {
  it('quando outra execução já detém o lock, retorna exit 0 sem processar nada', async () => {
    const pool = getPool();
    const lockConn = await pool.getConnection();
    try {
      const [[{ got }]] = await lockConn.query(
        "SELECT GET_LOCK('sentinela_integrations_dispatch', 0) AS got",
      );
      expect(got).toBe(1);

      await withTx(async (conn) => {
        process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
        await seedTenantAndIntegration(conn, { tenantId: 930007, integrationId: 930007 });

        let called = false;
        const fetchImpl = async () => { called = true; return { status: 200, headers: fakeHeaders() }; };

        // runDispatch aqui usa `conn` (a mesma conexão de teste) para o trabalho, mas a checagem de
        // lock é feita contra o servidor MySQL real via `pool` (getPool()), que já está travado por
        // `lockConn` acima — simula a segunda execução concorrente.
        const result = await runDispatch({
          pool: conn, lockPool: pool, now: NOW, fetchImpl, allowHttp: true,
        });

        expect(result.exitCode).toBe(0);
        expect(result.skipped).toBe(true);
        expect(called).toBe(false);

        const [batches] = await conn.query(
          'SELECT * FROM integration_delivery_batches WHERE tenant_id = ?', [930007],
        );
        expect(batches).toHaveLength(0);
      });
    } finally {
      await lockConn.query("SELECT RELEASE_LOCK('sentinela_integrations_dispatch')");
      lockConn.release();
    }
  });
});

// ---- R4 hardening: máquina de estados de retry orquestrada pelo job (Fase 2) ----

describe('runDispatch — retry persistido: 1ª falha agenda, respeita next_attempt_at', () => {
  it('1ª falha (500) agenda pending_retry ~ now+2min; ciclo ANTES do vencimento não tenta; ciclo DEPOIS tenta', async () => {
    await withTx(async (conn) => {
      process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
      await seedTenantAndIntegration(conn, { tenantId: 931001, integrationId: 931001 });

      const fetchImpl = async () => ({ status: 500, headers: fakeHeaders() });

      const first = await runDispatch({ pool: conn, now: NOW, fetchImpl, allowHttp: true });
      // Uma falha retryable que agenda retry NÃO é uma falha operacional do job (comportamento
      // esperado — o próprio job vai reprocessar no vencimento) — exit code permanece 0. Só
      // `failed` (terminal) ou exceção de config tornam o exit code != 0.
      expect(first.exitCode).toBe(0);

      const [afterFirst] = await conn.query(
        'SELECT * FROM integration_delivery_batches WHERE tenant_id = ?', [931001],
      );
      expect(afterFirst[0].status).toBe('pending_retry');
      expect(afterFirst[0].attempt_count).toBe(1);
      const nextAttemptAt = new Date(afterFirst[0].next_attempt_at);
      const expected = new Date(NOW.getTime() + 2 * 60_000);
      expect(nextAttemptAt.getTime()).toBe(expected.getTime());

      // Ciclo ANTES do vencimento (now + 1min): não tenta de novo.
      let callCount = 0;
      const countingFetch = async () => { callCount += 1; return { status: 500, headers: fakeHeaders() }; };
      const before = new Date(NOW.getTime() + 60_000);
      await runDispatch({ pool: conn, now: before, fetchImpl: countingFetch, allowHttp: true });
      expect(callCount).toBe(0);
      const [stillSame] = await conn.query(
        'SELECT attempt_count FROM integration_delivery_batches WHERE tenant_id = ?', [931001],
      );
      expect(stillSame[0].attempt_count).toBe(1);

      // Ciclo DEPOIS do vencimento (now + 3min): tenta de novo.
      const after = new Date(NOW.getTime() + 3 * 60_000);
      await runDispatch({ pool: conn, now: after, fetchImpl: countingFetch, allowHttp: true });
      expect(callCount).toBe(1);
      const [afterSecond] = await conn.query(
        'SELECT attempt_count FROM integration_delivery_batches WHERE tenant_id = ?', [931001],
      );
      expect(afterSecond[0].attempt_count).toBe(2);
    });
  });
});

describe('runDispatch — sucesso cancela retries futuros', () => {
  it('batch pending_retry vencido que agora tem sucesso vira delivered (terminal), não é re-tentado no próximo ciclo', async () => {
    await withTx(async (conn) => {
      process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
      await seedTenantAndIntegration(conn, { tenantId: 931002, integrationId: 931002 });

      const failFetch = async () => ({ status: 500, headers: fakeHeaders() });
      await runDispatch({ pool: conn, now: NOW, fetchImpl: failFetch, allowHttp: true });

      const after = new Date(NOW.getTime() + 3 * 60_000);
      let callCount = 0;
      const okFetch = async () => { callCount += 1; return { status: 200, headers: fakeHeaders() }; };
      const result = await runDispatch({ pool: conn, now: after, fetchImpl: okFetch, allowHttp: true });
      expect(result.exitCode).toBe(0);
      expect(callCount).toBe(1);

      const [batches] = await conn.query(
        'SELECT * FROM integration_delivery_batches WHERE tenant_id = ?', [931002],
      );
      expect(batches[0].status).toBe('delivered');
      expect(batches[0].next_attempt_at).toBeNull();
      const deliveredBatchId = batches[0].id;

      // Próximo ciclo, ainda no MESMO dia/janela (sem novo `computeDueWindow` disponível) — este
      // batch específico (já delivered/terminal) não é re-tentado.
      const soonAfter = new Date(after.getTime() + 5 * 60_000);
      const thirdResult = await runDispatch({ pool: conn, now: soonAfter, fetchImpl: okFetch, allowHttp: true });
      expect(thirdResult.exitCode).toBe(0);
      expect(callCount).toBe(1); // não incrementou — o batch delivered não voltou a ser elegível

      const [batchAfterThird] = await conn.query(
        'SELECT status FROM integration_delivery_batches WHERE id = ?', [deliveredBatchId],
      );
      expect(batchAfterThird[0].status).toBe('delivered'); // permanece terminal
    });
  });
});

describe('runDispatch — após esgotar maxAttempts vira failed', () => {
  it('4 falhas consecutivas (500) com maxAttempts=5 -> failed na 5ª (attempt_count esgota)', async () => {
    await withTx(async (conn) => {
      process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
      await seedTenantAndIntegration(conn, { tenantId: 931003, integrationId: 931003 });

      const failFetch = async () => ({ status: 500, headers: fakeHeaders() });
      const backoff = [1, 1, 1, 1]; // minutos curtos para o teste avançar rápido

      let now = NOW;
      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await runDispatch({
          pool: conn, now, fetchImpl: failFetch, allowHttp: true, backoffMinutes: backoff, maxAttempts: 5,
        });
        now = new Date(now.getTime() + 2 * 60_000); // avança além do próximo backoff (max 1min)
      }

      const [batches] = await conn.query(
        'SELECT * FROM integration_delivery_batches WHERE tenant_id = ?', [931003],
      );
      expect(batches[0].status).toBe('failed');
      expect(batches[0].attempt_count).toBe(5);
      expect(batches[0].next_attempt_at).toBeNull();

      const [attempts] = await conn.query(
        'SELECT * FROM integration_delivery_attempts WHERE tenant_id = ? ORDER BY attempt_no ASC', [931003],
      );
      expect(attempts).toHaveLength(5);
    });
  });
});

describe('runDispatch — concorrência: 2 conexões reais não duplicam a tentativa', () => {
  it('duas conexões físicas reais disputando claimBatchForAttempt no MESMO batch — exatamente uma reivindica (endereça R3 Important #2)', async () => {
    // Usa o POOL REAL (getPool(), não withTx) para ter DUAS conexões físicas distintas — uma
    // única transação de teste não provaria nada sobre concorrência real (MySQL serializaria as
    // duas "conexões" internamente na mesma sessão). Aqui cada lado do Promise.all usa sua própria
    // conexão do pool, exatamente como dois workers do job (ou job + reenvio manual) concorrentes
    // fariam em produção.
    const pool = getPool();
    const tenantId = 931900 + Math.floor(Math.random() * 100000);

    await pool.query(
      "INSERT INTO tenants (id, name, status) VALUES (?, ?, 'active')", [tenantId, `T-${tenantId}`],
    );
    await pool.query(
      `INSERT INTO tenant_integrations
         (id, tenant_id, type, active, target_url, frequency, run_at_time, timezone,
          include_direct, include_groups, include_from_me, include_audio_transcripts)
       VALUES (?, ?, 'webhook_batch', 1, 'https://example.com/webhook', 'daily', '03:00', 'America/Sao_Paulo', 1, 1, 1, 0)`,
      [tenantId, tenantId],
    );
    const [ins] = await pool.query(
      `INSERT INTO integration_delivery_batches
         (tenant_id, integration_id, schema_version, window_start, window_end, part, part_total,
          idempotency_key, status, conversation_count, message_count, attempt_count)
       VALUES (?, ?, 1, '2026-03-10 03:00:00', '2026-03-11 03:00:00', 1, 1, ?, 'pending', 0, 0, 0)`,
      [tenantId, tenantId, `k-race-${tenantId}`],
    );
    const batchId = ins.insertId;

    const connA = await pool.getConnection();
    const connB = await pool.getConnection();
    try {
      const now = new Date('2026-03-11T10:00:00Z');
      const [claimA, claimB] = await Promise.all([
        claimBatchForAttempt(connA, batchId, { now, includeBlocked: true }),
        claimBatchForAttempt(connB, batchId, { now, includeBlocked: true }),
      ]);

      const claimedCount = [claimA.claimed, claimB.claimed].filter(Boolean).length;
      expect(claimedCount).toBe(1); // exatamente uma das duas conexões reivindicou — nunca as duas

      const [rows] = await pool.query(
        'SELECT status FROM integration_delivery_batches WHERE id = ?', [batchId],
      );
      expect(rows[0].status).toBe('delivering'); // não fica em estado ambíguo
    } finally {
      connA.release();
      connB.release();
      await pool.query('DELETE FROM integration_delivery_attempts WHERE tenant_id = ?', [tenantId]);
      await pool.query('DELETE FROM integration_delivery_batches WHERE tenant_id = ?', [tenantId]);
      await pool.query('DELETE FROM tenant_integrations WHERE tenant_id = ?', [tenantId]);
      await pool.query('DELETE FROM tenants WHERE id = ?', [tenantId]);
    }
  });

  it('duas execuções REAIS de runDispatch (pool real, sem lock pré-adquirido nesta conexão) sobre o mesmo batch nunca gravam 2 attempts para o mesmo ciclo', async () => {
    // Complementa o teste acima operando no nível do JOB inteiro (não só a primitiva): duas
    // chamadas concorrentes de `runDispatch` usando o pool real. Como runDispatch adquire
    // GET_LOCK, a segunda chamada concorrente naturalmente encontra o lock ocupado e sai cedo
    // (skipped) — o que É a proteção esperada em produção (cron sobreposto). Prova que o resultado
    // final tem NO MÁXIMO 1 tentativa nova, nunca 2, mesmo dsparando ambas ao mesmo tempo.
    const pool = getPool();
    const tenantId = 931990 + Math.floor(Math.random() * 100000);
    try {
      process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
      await seedTenantAndIntegration(pool, { tenantId, integrationId: tenantId });

      let deliveryCalls = 0;
      const fetchImpl = async () => {
        deliveryCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { status: 200, headers: fakeHeaders() };
      };

      const [resultA, resultB] = await Promise.all([
        runDispatch({ pool, now: NOW, fetchImpl, allowHttp: true }),
        runDispatch({ pool, now: NOW, fetchImpl, allowHttp: true }),
      ]);

      // Uma das duas foi "skipped" pelo lock (ou ambas processaram sequencialmente pelo lock —
      // qualquer combinação é aceitável); o que NUNCA pode acontecer é 2 entregas para o mesmo
      // batch nesta janela.
      expect([resultA.skipped, resultB.skipped].some((s) => s === true) || deliveryCalls <= 1).toBe(true);
      expect(deliveryCalls).toBeLessThanOrEqual(1);

      const [attempts] = await pool.query(
        'SELECT * FROM integration_delivery_attempts WHERE tenant_id = ?', [tenantId],
      );
      expect(attempts.length).toBeLessThanOrEqual(1);
    } finally {
      await pool.query('DELETE FROM integration_delivery_attempts WHERE tenant_id = ?', [tenantId]);
      await pool.query('DELETE FROM integration_delivery_batches WHERE tenant_id = ?', [tenantId]);
      await pool.query('DELETE FROM tenant_integrations WHERE tenant_id = ?', [tenantId]);
      await pool.query('DELETE FROM tenants WHERE id = ?', [tenantId]);
    }
  });
});

describe('runDispatch — gate OFF: sem rajada, sem consumir tentativas', () => {
  it('gate OFF cria batches blocked mas Fase 2 é pulada inteiramente (nenhum attempt gravado)', async () => {
    await withTx(async (conn) => {
      delete process.env.EXTERNAL_INTEGRATIONS_ENABLED;
      await seedTenantAndIntegration(conn, { tenantId: 931004, integrationId: 931004 });

      let called = false;
      const fetchImpl = async () => { called = true; return { status: 200, headers: fakeHeaders() }; };

      // Roda várias vezes seguidas (simulando vários ciclos de cron) — nunca deve tentar entregar.
      for (let i = 0; i < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await runDispatch({ pool: conn, now: NOW, fetchImpl, allowHttp: true });
      }

      expect(called).toBe(false);
      const [batches] = await conn.query(
        'SELECT * FROM integration_delivery_batches WHERE tenant_id = ?', [931004],
      );
      expect(batches).toHaveLength(1);
      expect(batches[0].status).toBe('blocked');
      expect(batches[0].attempt_count).toBe(0);

      const [attempts] = await conn.query(
        'SELECT * FROM integration_delivery_attempts WHERE tenant_id = ?', [931004],
      );
      expect(attempts).toHaveLength(0); // nenhuma tentativa consumida
    });
  });

  it('religar o gate processa os batches blocked dentro do catchup, sem exigir reenvio manual', async () => {
    await withTx(async (conn) => {
      delete process.env.EXTERNAL_INTEGRATIONS_ENABLED;
      await seedTenantAndIntegration(conn, { tenantId: 931005, integrationId: 931005 });
      await runDispatch({ pool: conn, now: NOW, allowHttp: true }); // cria batch blocked

      const [blockedBefore] = await conn.query(
        'SELECT * FROM integration_delivery_batches WHERE tenant_id = ?', [931005],
      );
      expect(blockedBefore[0].status).toBe('blocked');

      process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
      const okFetch = async () => ({ status: 200, headers: fakeHeaders() });
      const later = new Date(NOW.getTime() + 60 * 60_000); // 1h depois, mesmo dia — dentro do catchup
      const result = await runDispatch({ pool: conn, now: later, fetchImpl: okFetch, allowHttp: true });

      expect(result.exitCode).toBe(0);
      const [batches] = await conn.query(
        'SELECT * FROM integration_delivery_batches WHERE tenant_id = ?', [931005],
      );
      expect(batches[0].status).toBe('delivered');
    });
  });

  it('batch blocked mais antigo que o catchup NÃO é entregue automaticamente ao religar o gate', async () => {
    await withTx(async (conn) => {
      const tenantId = 931006;
      await conn.query("INSERT INTO tenants (id, name, status) VALUES (?, ?, 'active')", [tenantId, `T-${tenantId}`]);
      await conn.query(
        `INSERT INTO tenant_integrations (id, tenant_id, type, active, target_url, frequency, run_at_time, timezone,
           include_direct, include_groups, include_from_me, include_audio_transcripts)
         VALUES (?, ?, 'webhook_batch', 1, 'https://example.com/webhook', 'daily', '03:00', 'America/Sao_Paulo', 1, 1, 1, 0)`,
        [tenantId, tenantId],
      );
      const oldEnd = new Date(NOW.getTime() - 10 * 24 * 60 * 60_000); // 10 dias antes (> catchup default de 7)
      const oldStart = new Date(oldEnd.getTime() - 24 * 60 * 60_000);
      await conn.query(
        `INSERT INTO integration_delivery_batches
           (tenant_id, integration_id, schema_version, window_start, window_end, part, part_total,
            idempotency_key, status, conversation_count, message_count, attempt_count)
         VALUES (?, ?, 1, ?, ?, 1, 1, ?, 'blocked', 0, 0, 0)`,
        [tenantId, tenantId, oldStart, oldEnd, `k-old-blocked-${tenantId}`],
      );

      process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
      let called = false;
      const fetchImpl = async () => { called = true; return { status: 200, headers: fakeHeaders() }; };
      await runDispatch({ pool: conn, now: NOW, fetchImpl, allowHttp: true });

      expect(called).toBe(false); // batch antigo demais não é elegível
      const [batches] = await conn.query(
        'SELECT status FROM integration_delivery_batches WHERE tenant_id = ?', [tenantId],
      );
      expect(batches[0].status).toBe('blocked'); // permanece blocked (histórico), não vira failed
    });
  });
});

describe('runDispatch — classificação retryable vs non-retryable', () => {
  it('HTTP 400 (não-retryable) falha direto, sem esgotar 5 tentativas', async () => {
    await withTx(async (conn) => {
      process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
      await seedTenantAndIntegration(conn, { tenantId: 931007, integrationId: 931007 });

      const fetchImpl = async () => ({ status: 400, headers: fakeHeaders() });
      await runDispatch({ pool: conn, now: NOW, fetchImpl, allowHttp: true, maxAttempts: 5 });

      const [batches] = await conn.query(
        'SELECT * FROM integration_delivery_batches WHERE tenant_id = ?', [931007],
      );
      expect(batches[0].status).toBe('failed');
      expect(batches[0].attempt_count).toBe(1); // uma tentativa só — não retentou

      const [attempts] = await conn.query(
        'SELECT * FROM integration_delivery_attempts WHERE tenant_id = ?', [931007],
      );
      expect(attempts).toHaveLength(1);
    });
  });

  it('timeout (retryable) agenda retry ao invés de falhar direto', async () => {
    await withTx(async (conn) => {
      process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
      await seedTenantAndIntegration(conn, { tenantId: 931008, integrationId: 931008 });

      const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
      const fetchImpl = async () => { throw abortError; };
      await runDispatch({ pool: conn, now: NOW, fetchImpl, allowHttp: true, maxAttempts: 5 });

      const [batches] = await conn.query(
        'SELECT * FROM integration_delivery_batches WHERE tenant_id = ?', [931008],
      );
      expect(batches[0].status).toBe('pending_retry');
      expect(batches[0].attempt_count).toBe(1);

      const [attempts] = await conn.query(
        'SELECT * FROM integration_delivery_attempts WHERE tenant_id = ?', [931008],
      );
      expect(attempts[0].error).toBe('TIMEOUT');
    });
  });

  it('HTTP 429 (retryable) agenda retry', async () => {
    await withTx(async (conn) => {
      process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
      await seedTenantAndIntegration(conn, { tenantId: 931009, integrationId: 931009 });

      const fetchImpl = async () => ({ status: 429, headers: fakeHeaders() });
      await runDispatch({ pool: conn, now: NOW, fetchImpl, allowHttp: true, maxAttempts: 5 });

      const [batches] = await conn.query(
        'SELECT * FROM integration_delivery_batches WHERE tenant_id = ?', [931009],
      );
      expect(batches[0].status).toBe('pending_retry');
    });
  });
});

describe('runDispatch — logs sanitizados', () => {
  it('nunca loga URL/secret/corpo — só códigos sanitizados, ids e contadores', async () => {
    await withTx(async (conn) => {
      process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
      await seedTenantAndIntegration(conn, { tenantId: 931010, integrationId: 931010 });

      const secretPlaintext = 'whsec_test-931010';
      const targetUrl = 'https://example.com/webhook';

      const logs = [];
      const originalLog = console.log;
      const originalError = console.error;
      console.log = (...args) => logs.push(args.join(' '));
      console.error = (...args) => logs.push(args.join(' '));
      try {
        const fetchImpl = async () => ({ status: 500, headers: fakeHeaders() });
        await runDispatch({ pool: conn, now: NOW, fetchImpl, allowHttp: true });
      } finally {
        console.log = originalLog;
        console.error = originalError;
      }

      const joined = logs.join('\n');
      expect(joined).not.toContain(secretPlaintext);
      expect(joined).not.toContain(targetUrl);
      expect(joined).not.toContain('whsec_'); // nenhum prefixo de secret
      // deve conter só códigos/ids/contadores esperados
      expect(joined).toMatch(/dispatch:/);
    });
  });
});

// ---- Etapa B, S3 — teste obrigatório 11: logs/auditoria nunca incluem o corpo do payload ----
describe('runDispatch — logs e auditoria não incluem o corpo do payload (Etapa B, S3, teste 11)', () => {
  it('mensagem de texto distintiva do payload nunca aparece em console.log/console.error nem em access_logs.metadata', async () => {
    await withTx(async (conn) => {
      process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
      const tenantId = 932001;
      const integrationId = 932001;
      await seedTenantAndIntegration(conn, { tenantId, integrationId });

      const MARKER = 'CONTEUDO-SECRETO-DA-MENSAGEM-QUE-NUNCA-PODE-VAZAR-EM-LOG';
      await conn.query(
        `INSERT INTO chats (id, tenant_id, title, is_group) VALUES ('chat-932001', ?, NULL, 0)`,
        [tenantId],
      );
      await conn.query(
        `INSERT INTO messages (id, tenant_id, chat_id, text, type, from_me, from_internal, timestamp)
         VALUES ('mkr1', ?, 'chat-932001', ?, 'text', 0, 0, '2026-03-10 10:00:00')`,
        [tenantId, MARKER],
      );

      const logs = [];
      const originalLog = console.log;
      const originalError = console.error;
      console.log = (...args) => logs.push(args.join(' '));
      console.error = (...args) => logs.push(args.join(' '));
      let result;
      try {
        const fetchImpl = async () => ({ status: 200, headers: fakeHeaders() });
        result = await runDispatch({ pool: conn, now: NOW, fetchImpl, allowHttp: true });
      } finally {
        console.log = originalLog;
        console.error = originalError;
      }

      expect(result.exitCode).toBe(0);
      const joined = logs.join('\n');
      expect(joined).not.toContain(MARKER);

      const [auditRows] = await conn.query(
        "SELECT metadata FROM access_logs WHERE tenant_id = ? AND action = 'deliver_integration'",
        [tenantId],
      );
      expect(auditRows.length).toBeGreaterThan(0);
      const auditJoined = JSON.stringify(auditRows.map((r) => r.metadata));
      expect(auditJoined).not.toContain(MARKER);
    });
  });
});
