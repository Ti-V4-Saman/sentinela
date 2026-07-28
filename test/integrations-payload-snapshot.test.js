// Etapa B — snapshot imutável do payload (S2): testa o util PURO de codificação/decodificação do
// corpo exato (rawBody) que é persistido no batch e depois assinado/enviado sem reconstrução — ver
// docs/superpowers/plans/2026-07-28-etapaB-payload-snapshot.md, seção "Formato do snapshot".

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  encodeSnapshot, decodeSnapshot, sha256Hex, PAYLOAD_MAX_BYTES,
} from '../server/integrations/payload-snapshot.js';

describe('encodeSnapshot / decodeSnapshot — round-trip', () => {
  it('decodeSnapshot(encodeSnapshot(rawBody)) retorna exatamente o rawBody original', () => {
    const rawBody = JSON.stringify({ schema_version: 1, batch: { part: 1 }, messages: [{ a: 1 }, { b: 'ç é ü 中文' }] });
    const snap = encodeSnapshot(rawBody);

    expect(snap.encoding).toBe('gzip');
    expect(Buffer.isBuffer(snap.compressed)).toBe(true);
    expect(snap.sizeBytes).toBe(Buffer.byteLength(rawBody, 'utf8'));

    const decoded = decodeSnapshot(snap);
    expect(decoded).toBe(rawBody);
  });

  it('sha256 é calculado sobre os bytes DESCOMPRIMIDOS (não sobre o buffer comprimido)', () => {
    const rawBody = JSON.stringify({ hello: 'world', n: 42 });
    const snap = encodeSnapshot(rawBody);

    const expectedSha = createHash('sha256').update(rawBody, 'utf8').digest('hex');
    expect(snap.sha256).toBe(expectedSha);
    expect(snap.sha256).not.toBe(createHash('sha256').update(snap.compressed).digest('hex'));
  });

  it('sha256Hex helper bate com crypto direto', () => {
    const s = 'texto qualquer com acentuação';
    expect(sha256Hex(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
  });

  it('rawBody vazio/objeto minúsculo também funciona', () => {
    const rawBody = JSON.stringify({});
    const snap = encodeSnapshot(rawBody);
    expect(decodeSnapshot(snap)).toBe(rawBody);
  });
});

describe('encodeSnapshot — validações', () => {
  it('rawBody não-string lança PAYLOAD_INVALID_INPUT', () => {
    expect(() => encodeSnapshot({ not: 'a string' })).toThrow('PAYLOAD_INVALID_INPUT');
  });

  it('rawBody maior que PAYLOAD_MAX_BYTES (8_000_000) lança PAYLOAD_TOO_LARGE', () => {
    // Gera uma string cujo tamanho em bytes UTF-8 excede o limite absoluto.
    const big = JSON.stringify({ messages: [{ text: 'x'.repeat(PAYLOAD_MAX_BYTES + 1000) }] });
    expect(big.length).toBeGreaterThan(PAYLOAD_MAX_BYTES);
    expect(() => encodeSnapshot(big)).toThrow('PAYLOAD_TOO_LARGE');
  });

  it('rawBody exatamente no limite (PAYLOAD_MAX_BYTES bytes) NÃO lança', () => {
    // Monta uma string ASCII cujo Buffer.byteLength é exatamente PAYLOAD_MAX_BYTES.
    const rawBody = 'x'.repeat(PAYLOAD_MAX_BYTES);
    expect(Buffer.byteLength(rawBody, 'utf8')).toBe(PAYLOAD_MAX_BYTES);
    expect(() => encodeSnapshot(rawBody)).not.toThrow();
  });
});

describe('decodeSnapshot — validações de integridade', () => {
  it('encoding desconhecido lança UNKNOWN_ENCODING', () => {
    const rawBody = JSON.stringify({ a: 1 });
    const snap = encodeSnapshot(rawBody);
    expect(() => decodeSnapshot({ ...snap, encoding: 'brotli' })).toThrow('UNKNOWN_ENCODING');
  });

  it('compressed adulterado (bytes trocados) lança PAYLOAD_INTEGRITY', () => {
    const rawBody = JSON.stringify({ a: 1, b: 2 });
    const snap = encodeSnapshot(rawBody);
    const tampered = Buffer.from(snap.compressed);
    tampered[tampered.length - 1] ^= 0xff; // flip do último byte
    expect(() => decodeSnapshot({ ...snap, compressed: tampered })).toThrow(/PAYLOAD_INTEGRITY/);
  });

  it('sha256 adulterado (não bate mais com o corpo real) lança PAYLOAD_INTEGRITY', () => {
    const rawBody = JSON.stringify({ a: 1 });
    const snap = encodeSnapshot(rawBody);
    const tamperedSha = '0'.repeat(64);
    expect(() => decodeSnapshot({ ...snap, sha256: tamperedSha })).toThrow('PAYLOAD_INTEGRITY');
  });

  it('sizeBytes adulterado (não bate mais com o corpo real) lança PAYLOAD_INTEGRITY', () => {
    const rawBody = JSON.stringify({ a: 1 });
    const snap = encodeSnapshot(rawBody);
    expect(() => decodeSnapshot({ ...snap, sizeBytes: snap.sizeBytes + 1 })).toThrow('PAYLOAD_INTEGRITY');
  });
});
