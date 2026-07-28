// Snapshot imutável do payload (Etapa B, S2) — ver
// docs/superpowers/plans/2026-07-28-etapaB-payload-snapshot.md, seção "Formato do snapshot".
//
// Módulo PURO: sem DB, sem rede. `rawBody` é sempre a string EXATA de `JSON.stringify(partPayload)`
// — a mesma que é assinada (HMAC) e enviada ao destino. Este módulo só (des)serializa/valida esses
// bytes; nunca decide QUANDO persistir/entregar (isso é responsabilidade de repo.js/job/delivery).
//
// Formato persistido (todos os campos calculados sobre os bytes EXATOS de `rawBody`, nunca sobre o
// comprimido):
// - compressed: Buffer — gzip de rawBody (zlib.gzipSync).
// - sha256: string hex (64 chars) — sha256(utf8(rawBody)).
// - sizeBytes: number — Buffer.byteLength(rawBody, 'utf8') (tamanho DESCOMPRIMIDO).
// - encoding: 'gzip' (esquema versionável — decodeSnapshot escolhe a estratégia por este campo).

import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

// Cap absoluto de segurança (bytes, descomprimido) — ver plano, item 7. O chunker (payload.js) já
// mantém ~5MB por parte; este é o limite duro que NUNCA deve ser ultrapassado antes de persistir.
export const PAYLOAD_MAX_BYTES = 8_000_000;

export function sha256Hex(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// Comprime + hasheia `rawBody` (a string exata que será assinada/enviada). Lança:
// - Error('PAYLOAD_TOO_LARGE') se sizeBytes > PAYLOAD_MAX_BYTES.
export function encodeSnapshot(rawBody) {
  if (typeof rawBody !== 'string') {
    throw new Error('PAYLOAD_INVALID_INPUT');
  }
  const sizeBytes = Buffer.byteLength(rawBody, 'utf8');
  if (sizeBytes > PAYLOAD_MAX_BYTES) {
    throw new Error('PAYLOAD_TOO_LARGE');
  }
  const sha256 = sha256Hex(rawBody);
  const compressed = gzipSync(Buffer.from(rawBody, 'utf8'));
  return { compressed, sha256, sizeBytes, encoding: 'gzip' };
}

// Descomprime e verifica auto-consistência (tamanho + hash sobre os bytes descomprimidos). Lança:
// - Error('UNKNOWN_ENCODING') se `encoding` não for reconhecido.
// - Error('PAYLOAD_INTEGRITY') se o tamanho ou o hash não baterem com o que foi persistido —
//   detector de adulteração/inconsistência no banco (nunca entrega um payload divergente).
export function decodeSnapshot({ compressed, encoding, sha256, sizeBytes }) {
  if (encoding !== 'gzip') {
    throw new Error('UNKNOWN_ENCODING');
  }
  let rawBody;
  try {
    rawBody = gunzipSync(compressed).toString('utf8');
  } catch {
    throw new Error('PAYLOAD_INTEGRITY');
  }
  const actualSize = Buffer.byteLength(rawBody, 'utf8');
  const actualSha = sha256Hex(rawBody);
  if (actualSize !== sizeBytes || actualSha !== sha256) {
    throw new Error('PAYLOAD_INTEGRITY');
  }
  return rawBody;
}
