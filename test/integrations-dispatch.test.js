// Job de despacho idempotente (Etapa B — integração em lote). Testa `runDispatch` isoladamente:
// lock anti-concorrência, varredura de integrações ativas com janela vencida, criação idempotente
// de batch(es), entrega (ou não, se o gate global estiver desligado), atualização de
// `last_run_window_end`, tolerância a exceções por config (uma config ruim não derruba o job) e
// exit code coerente. `now` e `fetchImpl` são SEMPRE injetados — nunca relógio/rede reais.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { getPool, applyMigrations, withTx } from './helpers/db.js';
import { runDispatch } from '../server/jobs/dispatch-integrations.js';
import { encryptSecret } from '../server/integrations/secret.js';

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
  it('não crasha: grava attempt failure SECRET_NOT_SET, marca batch failed, janela processada, exit != 0', async () => {
    await withTx(async (conn) => {
      process.env.EXTERNAL_INTEGRATIONS_ENABLED = 'true';
      await seedTenantAndIntegration(conn, { tenantId: 930008, integrationId: 930008, withSecret: false });

      let called = false;
      const fetchImpl = async () => { called = true; return { status: 200, headers: fakeHeaders() }; };

      const result = await runDispatch({ pool: conn, now: NOW, fetchImpl, allowHttp: true });

      expect(called).toBe(false); // nunca tenta assinar/entregar sem secret
      expect(result.exitCode).not.toBe(0);

      const [batches] = await conn.query(
        'SELECT * FROM integration_delivery_batches WHERE tenant_id = ?', [930008],
      );
      expect(batches).toHaveLength(1);
      expect(batches[0].status).toBe('failed');

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
