// Assinatura HMAC-SHA256 timing-safe para entregas de webhook (Etapa B — integração em lote).
// Sem DB/rede: testa apenas o módulo puro server/integrations/signature.js.

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { sign, verify, buildHeaders } from '../server/integrations/signature.js';

// Vetor conhecido, fixo — pin do esquema de assinatura. Se este teste quebrar, o ESQUEMA mudou
// (não só a implementação), o que é uma mudança incompatível para receptores existentes.
const FIXED_SECRET = 'whsec_test_secret_fixture';
const FIXED_TIMESTAMP = '1735689600';
const FIXED_BODY = '{"schema_version":1,"batch":{"tenant_id":42}}';
const EXPECTED_HEX = '24f139c12fa78842f81d0f85a0c52aafc080a9bd53bde3d0de53686f75b90240';

describe('signature — HMAC-SHA256 timing-safe', () => {
  it('vetor conhecido: sign() retorna sha256=<hex> estável para entrada fixa', () => {
    expect(EXPECTED_HEX).toHaveLength(64);
    const result = sign(FIXED_BODY, FIXED_SECRET, FIXED_TIMESTAMP);
    expect(result).toBe(`sha256=${EXPECTED_HEX}`);
  });

  it('sign() bate com HMAC-SHA256 recomputado independentemente (derivação de referência)', () => {
    const expected = createHmac('sha256', FIXED_SECRET)
      .update(`${FIXED_TIMESTAMP}.${FIXED_BODY}`, 'utf8')
      .digest('hex');
    expect(sign(FIXED_BODY, FIXED_SECRET, FIXED_TIMESTAMP)).toBe(`sha256=${expected}`);
  });

  it('verify() retorna true para assinatura correta', () => {
    const header = sign(FIXED_BODY, FIXED_SECRET, FIXED_TIMESTAMP);
    expect(verify(FIXED_BODY, FIXED_SECRET, FIXED_TIMESTAMP, header)).toBe(true);
  });

  it('verify() retorna false se o body mudar por 1 char', () => {
    const header = sign(FIXED_BODY, FIXED_SECRET, FIXED_TIMESTAMP);
    const tamperedBody = FIXED_BODY.replace('42', '43');
    expect(verify(tamperedBody, FIXED_SECRET, FIXED_TIMESTAMP, header)).toBe(false);
  });

  it('verify() retorna false se o secret mudar por 1 char', () => {
    const header = sign(FIXED_BODY, FIXED_SECRET, FIXED_TIMESTAMP);
    const tamperedSecret = FIXED_SECRET.slice(0, -1) + (FIXED_SECRET.slice(-1) === 'e' ? 'f' : 'e');
    expect(verify(FIXED_BODY, tamperedSecret, FIXED_TIMESTAMP, header)).toBe(false);
  });

  it('verify() retorna false se o timestamp mudar por 1 char', () => {
    const header = sign(FIXED_BODY, FIXED_SECRET, FIXED_TIMESTAMP);
    const tamperedTimestamp = FIXED_TIMESTAMP.slice(0, -1) + (FIXED_TIMESTAMP.slice(-1) === '0' ? '1' : '0');
    expect(verify(FIXED_BODY, FIXED_SECRET, tamperedTimestamp, header)).toBe(false);
  });

  it('verify() retorna false (sem lançar) para header ausente, vazio ou malformado', () => {
    expect(() => verify(FIXED_BODY, FIXED_SECRET, FIXED_TIMESTAMP, undefined)).not.toThrow();
    expect(verify(FIXED_BODY, FIXED_SECRET, FIXED_TIMESTAMP, undefined)).toBe(false);
    expect(verify(FIXED_BODY, FIXED_SECRET, FIXED_TIMESTAMP, null)).toBe(false);
    expect(verify(FIXED_BODY, FIXED_SECRET, FIXED_TIMESTAMP, '')).toBe(false);
    expect(verify(FIXED_BODY, FIXED_SECRET, FIXED_TIMESTAMP, 'sha256=')).toBe(false);
    expect(verify(FIXED_BODY, FIXED_SECRET, FIXED_TIMESTAMP, 'sha256=abcd')).toBe(false);
    expect(verify(FIXED_BODY, FIXED_SECRET, FIXED_TIMESTAMP, 'not-even-prefixed')).toBe(false);
  });

  it('verify() é timing-safe: não lança mesmo com tamanhos completamente diferentes', () => {
    expect(() => verify(FIXED_BODY, FIXED_SECRET, FIXED_TIMESTAMP, 'sha256=00')).not.toThrow();
    expect(verify(FIXED_BODY, FIXED_SECRET, FIXED_TIMESTAMP, 'sha256=00')).toBe(false);
  });

  it('buildHeaders() retorna exatamente os 5 headers com os valores corretos', () => {
    const rawBody = FIXED_BODY;
    const headers = buildHeaders({
      rawBody,
      secret: FIXED_SECRET,
      timestamp: FIXED_TIMESTAMP,
      deliveryId: 'delivery-123',
      schemaVersion: 1,
      idempotencyKey: 't1-i1-2026-p1',
    });

    expect(Object.keys(headers).sort()).toEqual(
      [
        'Idempotency-Key',
        'X-Sentinela-Delivery',
        'X-Sentinela-Schema-Version',
        'X-Sentinela-Signature',
        'X-Sentinela-Timestamp',
      ].sort()
    );

    expect(headers['X-Sentinela-Signature']).toBe(sign(rawBody, FIXED_SECRET, FIXED_TIMESTAMP));
    expect(headers['X-Sentinela-Timestamp']).toBe(FIXED_TIMESTAMP);
    expect(headers['X-Sentinela-Delivery']).toBe('delivery-123');
    expect(headers['X-Sentinela-Schema-Version']).toBe('1');
    expect(headers['Idempotency-Key']).toBe('t1-i1-2026-p1');
  });

  it('buildHeaders(): a assinatura verifica contra o mesmo rawBody exato', () => {
    const rawBody = FIXED_BODY;
    const headers = buildHeaders({
      rawBody,
      secret: FIXED_SECRET,
      timestamp: FIXED_TIMESTAMP,
      deliveryId: 'delivery-abc',
      schemaVersion: 2,
      idempotencyKey: 'key-xyz',
    });

    expect(
      verify(rawBody, FIXED_SECRET, headers['X-Sentinela-Timestamp'], headers['X-Sentinela-Signature'])
    ).toBe(true);

    // Corpo diferente do assinado deve falhar a verificação.
    expect(
      verify(rawBody + ' ', FIXED_SECRET, headers['X-Sentinela-Timestamp'], headers['X-Sentinela-Signature'])
    ).toBe(false);
  });

  it('buildHeaders() sempre converte schemaVersion para string', () => {
    const headers = buildHeaders({
      rawBody: FIXED_BODY,
      secret: FIXED_SECRET,
      timestamp: FIXED_TIMESTAMP,
      deliveryId: 'd1',
      schemaVersion: 7,
      idempotencyKey: 'k1',
    });
    expect(headers['X-Sentinela-Schema-Version']).toBe('7');
    expect(typeof headers['X-Sentinela-Schema-Version']).toBe('string');
  });
});
