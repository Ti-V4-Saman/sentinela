// Etapa B — máquina de estados de entrega/retry (R2/R3/R4): testa as primitivas persistidas de
// retry/gate-off no repo (claimBatchForAttempt, listDueBatches, scheduleRetry, markDelivered,
// markBlocked, releaseClaim) — ver docs/superpowers/plans/2026-07-28-etapaB-hardening.md, seções
// "Máquina de estados de entrega/retry (R2/R3/R4)" e "Gate off + avanço de janela + catchup (R4)".
//
// Estas são as primitivas puras de repo — o job (próxima tarefa) as orquestra. Todos os testes usam
// um `now` injetado fixo (nunca o relógio real) para tornar a aritmética de backoff determinística.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getPool, applyMigrations, withTx } from './helpers/db.js';
import {
  createBatch,
  claimBatchForAttempt,
  listDueBatches,
  scheduleRetry,
  markDelivered,
  markBlocked,
  releaseClaim,
} from '../server/integrations/repo.js';

const NOW = new Date('2026-07-28T12:00:00Z');

let tenantSeq = 930000;
function nextTenantId() {
  tenantSeq += 1;
  return tenantSeq;
}

beforeAll(async () => { await applyMigrations(); });
afterAll(() => getPool().end());

// Cria um tenant + integração + batch com status/campos de retry arbitrários (INSERT direto, para
// controlar precisamente o estado inicial de cada teste — createBatch só cria em 'pending'/'blocked'
// via initialStatus, sem next_attempt_at/attempt_count customizados).
async function seedBatch(conn, {
  tenantId, integrationId = tenantId, status = 'pending', attemptCount = 0,
  nextAttemptAt = null, lastAttemptAt = null, windowStart = '2026-07-20 00:00:00',
  windowEnd = '2026-07-21 00:00:00', idempotencyKey,
}) {
  await conn.query(
    "INSERT INTO tenants (id, name, status) VALUES (?, ?, 'active') ON DUPLICATE KEY UPDATE name = VALUES(name)",
    [tenantId, `T-${tenantId}`],
  );
  await conn.query(
    `INSERT INTO tenant_integrations (id, tenant_id, type, active, target_url)
     VALUES (?, ?, 'webhook_batch', 1, 'https://example.com/hook')
     ON DUPLICATE KEY UPDATE target_url = VALUES(target_url)`,
    [integrationId, tenantId],
  );
  const key = idempotencyKey || `idem-${tenantId}-${Math.random().toString(36).slice(2)}`;
  const [result] = await conn.query(
    `INSERT INTO integration_delivery_batches
       (tenant_id, integration_id, schema_version, window_start, window_end, part, part_total,
        idempotency_key, status, conversation_count, message_count, attempt_count, next_attempt_at,
        last_attempt_at)
     VALUES (?, ?, 1, ?, ?, 1, 1, ?, ?, 0, 0, ?, ?, ?)`,
    [tenantId, integrationId, windowStart, windowEnd, key, status, attemptCount, nextAttemptAt, lastAttemptAt],
  );
  return result.insertId;
}

async function getBatchRow(conn, batchId) {
  const [rows] = await conn.query('SELECT * FROM integration_delivery_batches WHERE id = ?', [batchId]);
  return rows[0];
}

describe('claimBatchForAttempt', () => {
  it('claims a pending batch: status -> delivering, claimed:true', async () => {
    await withTx(async (conn) => {
      const tenantId = nextTenantId();
      const batchId = await seedBatch(conn, { tenantId, status: 'pending' });

      const result = await claimBatchForAttempt(conn, batchId, { now: NOW });

      expect(result.claimed).toBe(true);
      const row = await getBatchRow(conn, batchId);
      expect(row.status).toBe('delivering');
      expect(new Date(row.last_attempt_at).getTime()).toBe(NOW.getTime());
    });
  });

  it('second concurrent claim on the same batch returns claimed:false (concurrency guard)', async () => {
    await withTx(async (conn) => {
      const tenantId = nextTenantId();
      const batchId = await seedBatch(conn, { tenantId, status: 'pending' });

      const first = await claimBatchForAttempt(conn, batchId, { now: NOW });
      const second = await claimBatchForAttempt(conn, batchId, { now: NOW });

      expect(first.claimed).toBe(true);
      expect(second.claimed).toBe(false);
    });
  });

  it('does NOT claim a pending_retry batch whose next_attempt_at is in the future', async () => {
    await withTx(async (conn) => {
      const tenantId = nextTenantId();
      const future = new Date(NOW.getTime() + 60_000);
      const batchId = await seedBatch(conn, {
        tenantId, status: 'pending_retry', attemptCount: 1, nextAttemptAt: future,
      });

      const result = await claimBatchForAttempt(conn, batchId, { now: NOW });

      expect(result.claimed).toBe(false);
      const row = await getBatchRow(conn, batchId);
      expect(row.status).toBe('pending_retry');
    });
  });

  it('DOES claim a pending_retry batch whose next_attempt_at is past', async () => {
    await withTx(async (conn) => {
      const tenantId = nextTenantId();
      const past = new Date(NOW.getTime() - 60_000);
      const batchId = await seedBatch(conn, {
        tenantId, status: 'pending_retry', attemptCount: 1, nextAttemptAt: past,
      });

      const result = await claimBatchForAttempt(conn, batchId, { now: NOW });

      expect(result.claimed).toBe(true);
      const row = await getBatchRow(conn, batchId);
      expect(row.status).toBe('delivering');
    });
  });

  it('claims a blocked batch only when includeBlocked:true', async () => {
    await withTx(async (conn) => {
      const tenantId = nextTenantId();
      const batchId = await seedBatch(conn, { tenantId, status: 'blocked' });

      const withoutFlag = await claimBatchForAttempt(conn, batchId, { now: NOW });
      expect(withoutFlag.claimed).toBe(false);
      expect((await getBatchRow(conn, batchId)).status).toBe('blocked');

      const withFlag = await claimBatchForAttempt(conn, batchId, { now: NOW, includeBlocked: true });
      expect(withFlag.claimed).toBe(true);
      expect((await getBatchRow(conn, batchId)).status).toBe('delivering');
    });
  });
});

describe('listDueBatches', () => {
  it('returns pending + past-due pending_retry; excludes future pending_retry', async () => {
    await withTx(async (conn) => {
      const tenantId = nextTenantId();
      const past = new Date(NOW.getTime() - 60_000);
      const future = new Date(NOW.getTime() + 60_000);

      const pendingId = await seedBatch(conn, { tenantId, status: 'pending' });
      const pastRetryId = await seedBatch(conn, {
        tenantId, status: 'pending_retry', attemptCount: 1, nextAttemptAt: past,
        windowStart: '2026-07-21 00:00:00', windowEnd: '2026-07-22 00:00:00',
      });
      const futureRetryId = await seedBatch(conn, {
        tenantId, status: 'pending_retry', attemptCount: 1, nextAttemptAt: future,
        windowStart: '2026-07-22 00:00:00', windowEnd: '2026-07-23 00:00:00',
      });

      const rows = await listDueBatches(conn, { now: NOW, gateOn: true, limit: 50 });
      const ids = rows.map((r) => r.id);

      expect(ids).toContain(pendingId);
      expect(ids).toContain(pastRetryId);
      expect(ids).not.toContain(futureRetryId);
    });
  });

  it('includes blocked batches only when gateOn', async () => {
    await withTx(async (conn) => {
      const tenantId = nextTenantId();
      const blockedId = await seedBatch(conn, { tenantId, status: 'blocked' });

      const gateOff = await listDueBatches(conn, { now: NOW, gateOn: false, limit: 50 });
      expect(gateOff.map((r) => r.id)).not.toContain(blockedId);

      const gateOn = await listDueBatches(conn, { now: NOW, gateOn: true, limit: 50 });
      expect(gateOn.map((r) => r.id)).toContain(blockedId);
    });
  });

  it('excludes blocked batches older than maxCatchupDays even when gateOn', async () => {
    await withTx(async (conn) => {
      const tenantId = nextTenantId();
      // window_end 10 dias antes de NOW — além do catchup default de 7 dias.
      const oldEnd = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000);
      const recentEnd = new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000);

      const oldBlockedId = await seedBatch(conn, {
        tenantId, status: 'blocked',
        windowStart: new Date(oldEnd.getTime() - 3600_000), windowEnd: oldEnd,
      });
      const recentBlockedId = await seedBatch(conn, {
        tenantId, status: 'blocked',
        windowStart: new Date(recentEnd.getTime() - 3600_000), windowEnd: recentEnd,
      });

      const rows = await listDueBatches(conn, {
        now: NOW, gateOn: true, limit: 50, maxCatchupDays: 7,
      });
      const ids = rows.map((r) => r.id);

      expect(ids).not.toContain(oldBlockedId);
      expect(ids).toContain(recentBlockedId);
    });
  });
});

describe('scheduleRetry — aritmética de backoff', () => {
  const cases = [
    { attemptCount: 1, expectedMinutes: 2 },
    { attemptCount: 2, expectedMinutes: 6 },
    { attemptCount: 3, expectedMinutes: 18 },
    { attemptCount: 4, expectedMinutes: 54 },
  ];

  for (const { attemptCount, expectedMinutes } of cases) {
    it(`attempt_count ${attemptCount} -> pending_retry, next_attempt_at = now + ${expectedMinutes}min`, async () => {
      await withTx(async (conn) => {
        const tenantId = nextTenantId();
        const batchId = await seedBatch(conn, { tenantId, status: 'delivering', attemptCount });

        const result = await scheduleRetry(conn, batchId, {
          attemptCount, now: NOW, backoffMinutes: [2, 6, 18, 54], maxAttempts: 5,
        });

        const expectedNext = new Date(NOW.getTime() + expectedMinutes * 60_000);
        expect(result.status).toBe('pending_retry');
        expect(new Date(result.next_attempt_at).getTime()).toBe(expectedNext.getTime());

        const row = await getBatchRow(conn, batchId);
        expect(row.status).toBe('pending_retry');
        expect(row.attempt_count).toBe(attemptCount);
        expect(new Date(row.next_attempt_at).getTime()).toBe(expectedNext.getTime());
      });
    });
  }

  it('attempt_count 5 (== maxAttempts) -> status failed, next_attempt_at NULL', async () => {
    await withTx(async (conn) => {
      const tenantId = nextTenantId();
      const batchId = await seedBatch(conn, { tenantId, status: 'delivering', attemptCount: 5 });

      const result = await scheduleRetry(conn, batchId, {
        attemptCount: 5, now: NOW, backoffMinutes: [2, 6, 18, 54], maxAttempts: 5,
      });

      expect(result.status).toBe('failed');
      expect(result.next_attempt_at).toBeNull();

      const row = await getBatchRow(conn, batchId);
      expect(row.status).toBe('failed');
      expect(row.next_attempt_at).toBeNull();
    });
  });
});

describe('markDelivered', () => {
  it('sets status delivered, next_attempt_at NULL, terminal/idempotent', async () => {
    await withTx(async (conn) => {
      const tenantId = nextTenantId();
      const batchId = await seedBatch(conn, { tenantId, status: 'delivering', attemptCount: 1 });

      await markDelivered(conn, batchId, { now: NOW });

      const row = await getBatchRow(conn, batchId);
      expect(row.status).toBe('delivered');
      expect(row.next_attempt_at).toBeNull();

      // Idempotente: chamar de novo não lança e mantém delivered.
      await markDelivered(conn, batchId, { now: NOW });
      const row2 = await getBatchRow(conn, batchId);
      expect(row2.status).toBe('delivered');
    });
  });
});

describe('markBlocked', () => {
  it('sets status blocked', async () => {
    await withTx(async (conn) => {
      const tenantId = nextTenantId();
      const batchId = await seedBatch(conn, { tenantId, status: 'delivering' });

      await markBlocked(conn, batchId);

      const row = await getBatchRow(conn, batchId);
      expect(row.status).toBe('blocked');
    });
  });
});

describe('releaseClaim', () => {
  it('reverts a delivering claim back to the given toStatus without recording a failure', async () => {
    await withTx(async (conn) => {
      const tenantId = nextTenantId();
      const batchId = await seedBatch(conn, { tenantId, status: 'delivering', attemptCount: 0 });

      await releaseClaim(conn, batchId, { toStatus: 'pending' });

      const row = await getBatchRow(conn, batchId);
      expect(row.status).toBe('pending');
      expect(row.attempt_count).toBe(0);
    });
  });
});

describe('createBatch — initialStatus', () => {
  it('gate off: createBatch with initialStatus "blocked" creates the row as blocked', async () => {
    await withTx(async (conn) => {
      const tenantId = nextTenantId();
      await conn.query("INSERT INTO tenants (id, name, status) VALUES (?, ?, 'active')", [tenantId, `T-${tenantId}`]);
      await conn.query(
        `INSERT INTO tenant_integrations (id, tenant_id, type, active, target_url)
         VALUES (?, ?, 'webhook_batch', 1, 'https://example.com/hook')`,
        [tenantId, tenantId],
      );

      const result = await createBatch(conn, {
        tenantId, integrationId: tenantId, schemaVersion: 1,
        windowStart: '2026-07-20 00:00:00', windowEnd: '2026-07-21 00:00:00',
        part: 1, partTotal: 1, idempotencyKey: `idem-blocked-${tenantId}`,
        conversationCount: 0, messageCount: 0, initialStatus: 'blocked',
      });

      expect(result.created).toBe(true);
      const row = await getBatchRow(conn, result.id);
      expect(row.status).toBe('blocked');
    });
  });

  it('initialStatus never downgrades an already-existing row', async () => {
    await withTx(async (conn) => {
      const tenantId = nextTenantId();
      await conn.query("INSERT INTO tenants (id, name, status) VALUES (?, ?, 'active')", [tenantId, `T-${tenantId}`]);
      await conn.query(
        `INSERT INTO tenant_integrations (id, tenant_id, type, active, target_url)
         VALUES (?, ?, 'webhook_batch', 1, 'https://example.com/hook')`,
        [tenantId, tenantId],
      );

      const params = {
        tenantId, integrationId: tenantId, schemaVersion: 1,
        windowStart: '2026-07-20 00:00:00', windowEnd: '2026-07-21 00:00:00',
        part: 1, partTotal: 1, idempotencyKey: `idem-nodowngrade-${tenantId}`,
        conversationCount: 0, messageCount: 0,
      };

      const first = await createBatch(conn, { ...params, initialStatus: 'pending' });
      // Simula progresso real do batch (não seria mais 'pending' na vida real).
      await conn.query('UPDATE integration_delivery_batches SET status = ? WHERE id = ?', ['delivered', first.id]);

      const second = await createBatch(conn, { ...params, initialStatus: 'blocked' });

      expect(second.created).toBe(false);
      expect(second.id).toBe(first.id);
      const row = await getBatchRow(conn, first.id);
      expect(row.status).toBe('delivered');
    });
  });
});
