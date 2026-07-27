import { describe, it, expect } from 'vitest';
import { parseReportRange, MAX_RANGE_DAYS } from '../server/reportRange.js';

describe('parseReportRange — validação de intervalo', () => {
  it('intervalo válido (inclusivo nos dois extremos, to exclusivo no dia seguinte)', () => {
    const r = parseReportRange({ from: '2026-07-01', to: '2026-07-31' });
    expect(r.error).toBeUndefined();
    expect(r.fromSql).toBe('2026-07-01 00:00:00');
    expect(r.toExclusiveSql).toBe('2026-08-01 00:00:00');
    expect(r.days).toBe(31);
  });
  it('mesmo dia → 1 dia', () => {
    const r = parseReportRange({ from: '2026-07-10', to: '2026-07-10' });
    expect(r.days).toBe(1);
    expect(r.toExclusiveSql).toBe('2026-07-11 00:00:00');
  });
  it('faltando from/to → erro', () => {
    expect(parseReportRange({ to: '2026-07-01' }).error).toBeTruthy();
    expect(parseReportRange({ from: '2026-07-01' }).error).toBeTruthy();
  });
  it('formato inválido → erro', () => {
    expect(parseReportRange({ from: '01/07/2026', to: '2026-07-31' }).error).toBeTruthy();
    expect(parseReportRange({ from: '2026-13-01', to: '2026-07-31' }).error).toBeTruthy();
    expect(parseReportRange({ from: '2025-02-29', to: '2025-03-01' }).error).toBeTruthy(); // não bissexto
  });
  it('bissexto válido', () => {
    expect(parseReportRange({ from: '2024-02-29', to: '2024-03-01' }).error).toBeUndefined();
  });
  it('from > to → erro', () => {
    expect(parseReportRange({ from: '2026-07-31', to: '2026-07-01' }).error).toBeTruthy();
  });
  it(`acima de ${MAX_RANGE_DAYS} dias → erro`, () => {
    expect(parseReportRange({ from: '2024-01-01', to: '2026-01-01' }).error).toBeTruthy();
  });
});
