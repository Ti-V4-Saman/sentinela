// Janela determinística (dia local anterior) + chave de idempotência (Etapa B — integração em lote).
// Sem DB/rede: testa apenas o módulo puro server/integrations/window.js.
// `nowUtc` é SEMPRE injetado — nunca depende do relógio real.

import { describe, it, expect } from 'vitest';
import { computeDueWindow, idempotencyKey, manualResendWindow } from '../server/integrations/window.js';

describe('window — computeDueWindow (America/Sao_Paulo, UTC-3, sem DST desde 2019)', () => {
  const cfg = {
    timezone: 'America/Sao_Paulo',
    run_at_time: '03:00',
    frequency: 'daily',
    last_run_window_end: null,
  };

  it('janela é o dia local anterior completo, convertida para UTC', () => {
    // "hoje" local = 2026-03-11 (nowUtc bem depois do dueAt), janela = 2026-03-10 [00:00,24:00) local
    // local 2026-03-10 00:00 -03:00 -> 2026-03-10T03:00:00Z
    // local 2026-03-11 00:00 -03:00 -> 2026-03-11T03:00:00Z
    const nowUtc = new Date('2026-03-11T10:00:00Z');
    const result = computeDueWindow(cfg, nowUtc);
    expect(result).not.toBeNull();
    expect(result.start.toISOString()).toBe('2026-03-10T03:00:00.000Z');
    expect(result.end.toISOString()).toBe('2026-03-11T03:00:00.000Z');
  });

  it('dueAt é o run_at_time de hoje (local) convertido para UTC', () => {
    const nowUtc = new Date('2026-03-11T10:00:00Z');
    const result = computeDueWindow(cfg, nowUtc);
    // dueAt = 2026-03-11 03:00 -03:00 -> 2026-03-11T06:00:00Z
    expect(result.dueAt.toISOString()).toBe('2026-03-11T06:00:00.000Z');
  });

  it('retorna null quando nowUtc é ANTES do dueAt de hoje', () => {
    // dueAt hoje = 2026-03-11T06:00:00Z; nowUtc antes disso
    const nowUtc = new Date('2026-03-11T05:00:00Z');
    expect(computeDueWindow(cfg, nowUtc)).toBeNull();
  });

  it('retorna não-null quando nowUtc é DEPOIS (ou igual) ao dueAt de hoje', () => {
    const nowUtc = new Date('2026-03-11T06:00:00Z');
    expect(computeDueWindow(cfg, nowUtc)).not.toBeNull();
    const nowUtcAfter = new Date('2026-03-11T06:00:01Z');
    expect(computeDueWindow({ ...cfg }, nowUtcAfter)).not.toBeNull();
  });

  it('retorna null quando a janela já foi processada (last_run_window_end >= end)', () => {
    const nowUtc = new Date('2026-03-11T10:00:00Z');
    // end da janela seria 2026-03-11T03:00:00Z; se last_run_window_end já cobre isso, null
    const cfgProcessed = { ...cfg, last_run_window_end: new Date('2026-03-11T03:00:00Z') };
    expect(computeDueWindow(cfgProcessed, nowUtc)).toBeNull();

    const cfgProcessedLater = { ...cfg, last_run_window_end: new Date('2026-03-12T03:00:00Z') };
    expect(computeDueWindow(cfgProcessedLater, nowUtc)).toBeNull();
  });

  it('não-null quando last_run_window_end é ANTERIOR ao end da janela devida (janela nova pendente)', () => {
    const nowUtc = new Date('2026-03-11T10:00:00Z');
    // last_run_window_end cobre até dois dias atrás — janela de 03-10 ainda não processada
    const cfgOlder = { ...cfg, last_run_window_end: new Date('2026-03-09T03:00:00Z') };
    const result = computeDueWindow(cfgOlder, nowUtc);
    expect(result).not.toBeNull();
    expect(result.end.toISOString()).toBe('2026-03-11T03:00:00.000Z');
  });

  it('é determinística: mesma (cfg, nowUtc) produz sempre o mesmo resultado', () => {
    const nowUtc = new Date('2026-03-11T10:00:00Z');
    const r1 = computeDueWindow(cfg, nowUtc);
    const r2 = computeDueWindow({ ...cfg }, new Date(nowUtc.getTime()));
    expect(r1.start.toISOString()).toBe(r2.start.toISOString());
    expect(r1.end.toISOString()).toBe(r2.end.toISOString());
    expect(r1.dueAt.toISOString()).toBe(r2.dueAt.toISOString());
  });
});

describe('window — DST (America/New_York, spring-forward em 2026-03-08)', () => {
  // Em 2026, o "spring forward" nos EUA ocorre em 2026-03-08 02:00 -> 03:00 local (EST UTC-5 -> EDT UTC-4).
  // O dia local 2026-03-08 tem, portanto, só 23 horas de relógio.
  const cfg = {
    timezone: 'America/New_York',
    run_at_time: '03:00',
    frequency: 'daily',
    last_run_window_end: null,
  };

  it('janela do dia de transição (2026-03-08) tem 23h de span UTC — documentado/intencional', () => {
    // "hoje" local = 2026-03-09; janela = dia local 2026-03-08 [00:00,24:00)
    const nowUtc = new Date('2026-03-09T12:00:00Z');
    const result = computeDueWindow(cfg, nowUtc);
    expect(result).not.toBeNull();
    // início do dia local 03-08 ainda em EST (UTC-5): 03-08 00:00 -05:00 -> 05:00Z
    expect(result.start.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    // início do dia local 03-09 já em EDT (UTC-4): 03-09 00:00 -04:00 -> 04:00Z
    expect(result.end.toISOString()).toBe('2026-03-09T04:00:00.000Z');
    const spanHours = (result.end.getTime() - result.start.getTime()) / 3600000;
    expect(spanHours).toBe(23);
  });

  it('fronteiras do dia local permanecem corretas (00:00 e 24:00 local) mesmo com span != 24h', () => {
    const nowUtc = new Date('2026-03-09T12:00:00Z');
    const result = computeDueWindow(cfg, nowUtc);
    // Verifica que result.start corresponde a exatamente 00:00 local em 2026-03-08 (EST, UTC-5)
    const startLocalHour = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour12: false,
      hour: '2-digit',
      day: '2-digit',
      month: '2-digit',
    }).formatToParts(result.start);
    const sh = Object.fromEntries(startLocalHour.map((p) => [p.type, p.value]));
    expect(sh.hour).toBe('00');
    expect(sh.day).toBe('08');
    expect(sh.month).toBe('03');

    // result.end corresponde a exatamente 00:00 local em 2026-03-09 (EDT, UTC-4)
    const endLocalHour = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour12: false,
      hour: '2-digit',
      day: '2-digit',
      month: '2-digit',
    }).formatToParts(result.end);
    const eh = Object.fromEntries(endLocalHour.map((p) => [p.type, p.value]));
    expect(eh.hour).toBe('00');
    expect(eh.day).toBe('09');
    expect(eh.month).toBe('03');
  });
});

describe('window — DST (America/New_York, fall-back em 2026-11-01)', () => {
  // Em 2026, o "fall back" nos EUA ocorre em 2026-11-01 02:00 -> 01:00 local (EDT UTC-4 -> EST UTC-5).
  // O dia local 2026-11-01 tem, portanto, 25 horas de relógio (uma hora "repetida").
  const cfg = {
    timezone: 'America/New_York',
    run_at_time: '03:00',
    frequency: 'daily',
    last_run_window_end: null,
  };

  it('janela do dia de transição (2026-11-01) tem 25h de span UTC — documentado/intencional', () => {
    // "hoje" local = 2026-11-02; janela = dia local 2026-11-01 [00:00,24:00)
    const nowUtc = new Date('2026-11-02T12:00:00Z');
    const result = computeDueWindow(cfg, nowUtc);
    expect(result).not.toBeNull();
    // início do dia local 11-01 ainda em EDT (UTC-4): 11-01 00:00 -04:00 -> 04:00Z
    expect(result.start.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    // início do dia local 11-02 já em EST (UTC-5): 11-02 00:00 -05:00 -> 05:00Z
    expect(result.end.toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(result.end.getTime() - result.start.getTime()).toBe(90000000); // 25h em ms
  });

  it('fronteiras do dia local permanecem corretas (00:00 e 24:00 local) mesmo com span de 25h', () => {
    const nowUtc = new Date('2026-11-02T12:00:00Z');
    const result = computeDueWindow(cfg, nowUtc);
    const startLocal = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour12: false,
      hour: '2-digit',
      day: '2-digit',
      month: '2-digit',
    }).formatToParts(result.start);
    const sh = Object.fromEntries(startLocal.map((p) => [p.type, p.value]));
    expect(sh.hour).toBe('00');
    expect(sh.day).toBe('01');
    expect(sh.month).toBe('11');

    const endLocal = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour12: false,
      hour: '2-digit',
      day: '2-digit',
      month: '2-digit',
    }).formatToParts(result.end);
    const eh = Object.fromEntries(endLocal.map((p) => [p.type, p.value]));
    expect(eh.hour).toBe('00');
    expect(eh.day).toBe('02');
    expect(eh.month).toBe('11');
  });
});

describe('window — idempotência: boundary exato em last_run_window_end (America/Sao_Paulo)', () => {
  const cfg = {
    timezone: 'America/Sao_Paulo',
    run_at_time: '03:00',
    frequency: 'daily',
  };

  it('Caso A: last_run_window_end == end da janela ANTERIOR, nowUtc no dia seguinte ao dueAt -> não bloqueia a janela nova', () => {
    // Janela devida em 2026-03-11 (dia local anterior = 03-10): end = 2026-03-11T03:00:00.000Z
    const previousWindowEnd = new Date('2026-03-11T03:00:00.000Z');
    // "Hoje" avança para 2026-03-12; a nova janela devida é o dia local 03-11 (end = 2026-03-12T03:00:00.000Z)
    const nowUtc = new Date('2026-03-12T10:00:00Z');
    const cfgNextDay = { ...cfg, last_run_window_end: previousWindowEnd };
    const result = computeDueWindow(cfgNextDay, nowUtc);
    expect(result).not.toBeNull();
    expect(result.end.toISOString()).toBe('2026-03-12T03:00:00.000Z');
  });

  it('Caso B: last_run_window_end === end da janela ATUAL -> bloqueia (retorna null, sem reprocessar)', () => {
    const nowUtc = new Date('2026-03-11T10:00:00Z');
    // end da janela devida hoje (dia local anterior = 03-10): 2026-03-11T03:00:00.000Z
    const currentWindowEnd = new Date('2026-03-11T03:00:00.000Z');
    const cfgBlocked = { ...cfg, last_run_window_end: currentWindowEnd };
    expect(computeDueWindow(cfgBlocked, nowUtc)).toBeNull();
  });

  it('Caso C: last_run_window_end 1ms ANTES do end da janela atual -> não bloqueia (não-null)', () => {
    const nowUtc = new Date('2026-03-11T10:00:00Z');
    const currentWindowEnd = new Date('2026-03-11T03:00:00.000Z');
    const cfgAlmostBlocked = { ...cfg, last_run_window_end: new Date(currentWindowEnd.getTime() - 1) };
    const result = computeDueWindow(cfgAlmostBlocked, nowUtc);
    expect(result).not.toBeNull();
    expect(result.end.toISOString()).toBe('2026-03-11T03:00:00.000Z');
  });
});

describe('window — idempotencyKey', () => {
  const base = {
    tenantId: 42,
    integrationId: 7,
    windowStart: new Date('2026-03-10T03:00:00.000Z'),
    windowEnd: new Date('2026-03-11T03:00:00.000Z'),
    schemaVersion: 1,
    part: 1,
  };

  it('é idêntica para inputs idênticos', () => {
    const k1 = idempotencyKey(base);
    const k2 = idempotencyKey({ ...base });
    expect(k1).toBe(k2);
  });

  it('segue o formato t{tenant}-i{integration}-{startISO}_{endISO}-v{schema}-p{part}', () => {
    const key = idempotencyKey(base);
    expect(key.startsWith('t42-i7-')).toBe(true);
    expect(key).toContain('-v1-p1');
    expect(key.length).toBeLessThanOrEqual(120);
  });

  it('muda quando tenantId muda', () => {
    const k1 = idempotencyKey(base);
    const k2 = idempotencyKey({ ...base, tenantId: 43 });
    expect(k1).not.toBe(k2);
  });

  it('muda quando integrationId muda', () => {
    const k1 = idempotencyKey(base);
    const k2 = idempotencyKey({ ...base, integrationId: 8 });
    expect(k1).not.toBe(k2);
  });

  it('muda quando windowStart muda', () => {
    const k1 = idempotencyKey(base);
    const k2 = idempotencyKey({ ...base, windowStart: new Date('2026-03-10T04:00:00.000Z') });
    expect(k1).not.toBe(k2);
  });

  it('muda quando windowEnd muda', () => {
    const k1 = idempotencyKey(base);
    const k2 = idempotencyKey({ ...base, windowEnd: new Date('2026-03-11T04:00:00.000Z') });
    expect(k1).not.toBe(k2);
  });

  it('muda quando schemaVersion muda', () => {
    const k1 = idempotencyKey(base);
    const k2 = idempotencyKey({ ...base, schemaVersion: 2 });
    expect(k1).not.toBe(k2);
  });

  it('muda quando part muda', () => {
    const k1 = idempotencyKey(base);
    const k2 = idempotencyKey({ ...base, part: 2 });
    expect(k1).not.toBe(k2);
  });

  it('nunca excede 120 caracteres mesmo com ids grandes', () => {
    const key = idempotencyKey({
      tenantId: 999999999,
      integrationId: 999999999,
      windowStart: new Date('2026-03-10T03:00:00.000Z'),
      windowEnd: new Date('2026-03-11T03:00:00.000Z'),
      schemaVersion: 99,
      part: 999,
    });
    expect(key.length).toBeLessThanOrEqual(120);
  });
});

describe('window — manualResendWindow', () => {
  it('reusa window_start/window_end armazenados do batch, sem alterar', () => {
    const batch = {
      id: 123,
      tenant_id: 42,
      integration_id: 7,
      window_start: new Date('2026-03-10T03:00:00.000Z'),
      window_end: new Date('2026-03-11T03:00:00.000Z'),
      part: 1,
      part_total: 1,
    };
    const result = manualResendWindow(batch);
    expect(result.start.toISOString()).toBe(batch.window_start.toISOString());
    expect(result.end.toISOString()).toBe(batch.window_end.toISOString());
  });

  it('produz a MESMA idempotencyKey do batch original ao recombinar com os demais campos', () => {
    const batch = {
      tenant_id: 42,
      integration_id: 7,
      window_start: new Date('2026-03-10T03:00:00.000Z'),
      window_end: new Date('2026-03-11T03:00:00.000Z'),
      part: 1,
    };
    const originalKey = idempotencyKey({
      tenantId: batch.tenant_id,
      integrationId: batch.integration_id,
      windowStart: batch.window_start,
      windowEnd: batch.window_end,
      schemaVersion: 1,
      part: batch.part,
    });

    const { start, end } = manualResendWindow(batch);
    const resendKey = idempotencyKey({
      tenantId: batch.tenant_id,
      integrationId: batch.integration_id,
      windowStart: start,
      windowEnd: end,
      schemaVersion: 1,
      part: batch.part,
    });

    expect(resendKey).toBe(originalKey);
  });
});
