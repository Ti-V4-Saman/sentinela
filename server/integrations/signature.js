// Assinatura HMAC-SHA256 timing-safe para entregas de webhook (Etapa B — integração em lote).
//
// Esquema: sha256=<hex> onde hex = HMAC-SHA256(secretPlaintext, `${timestamp}.${rawBody}`).
// `rawBody` DEVE ser a string exata (bytes exatos) enviada no corpo da requisição — assinar
// qualquer representação re-serializada quebra a verificação no receptor.
//
// Como o RECEPTOR deve validar uma entrega:
//   1. Ler o corpo bruto da requisição (sem parsear/reserializar) como `rawBody`.
//   2. Recomputar HMAC-SHA256(secret, `${X-Sentinela-Timestamp}.${rawBody}`) em hex.
//   3. Comparar o resultado (`sha256=<hex>`) ao header `X-Sentinela-Signature` de forma
//      timing-safe (nunca com `===`/`==`).
//   4. Rejeitar a entrega se `X-Sentinela-Timestamp` estiver fora de uma janela de tolerância
//      aceitável (proteção contra replay). A janela de tolerância é política do receptor —
//      este módulo não impõe nem valida tolerância, apenas assina/verifica a assinatura.

import { createHmac, timingSafeEqual } from 'node:crypto';

const SIGNATURE_PREFIX = 'sha256=';

// HMAC-SHA256(secretPlaintext, `${timestamp}.${rawBody}`) em hex, prefixado com "sha256=".
// `timestamp` é tratado como string opaca fornecida pelo chamador (não gerada aqui).
export function sign(rawBody, secretPlaintext, timestamp) {
  const hex = createHmac('sha256', secretPlaintext)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');
  return `${SIGNATURE_PREFIX}${hex}`;
}

// Verifica um header de assinatura contra o rawBody/secret/timestamp esperados, com comparação
// timing-safe. Nunca lança: qualquer entrada malformada, ausente ou de tamanho incompatível
// resulta em `false`.
export function verify(rawBody, secretPlaintext, timestamp, signatureHeader) {
  if (typeof signatureHeader !== 'string' || !signatureHeader.startsWith(SIGNATURE_PREFIX)) {
    return false;
  }

  const providedHex = signatureHeader.slice(SIGNATURE_PREFIX.length);
  const expectedHex = sign(rawBody, secretPlaintext, timestamp).slice(SIGNATURE_PREFIX.length);

  const provided = Buffer.from(providedHex, 'hex');
  const expected = Buffer.from(expectedHex, 'hex');

  if (provided.length !== expected.length || provided.length === 0) return false;
  return timingSafeEqual(provided, expected);
}

// Monta os headers de entrega padrão. A assinatura cobre exatamente o `rawBody` recebido.
export function buildHeaders({ rawBody, secret, timestamp, deliveryId, schemaVersion, idempotencyKey }) {
  return {
    'X-Sentinela-Signature': sign(rawBody, secret, timestamp),
    'X-Sentinela-Timestamp': timestamp,
    'X-Sentinela-Delivery': deliveryId,
    'X-Sentinela-Schema-Version': String(schemaVersion),
    'Idempotency-Key': idempotencyKey,
  };
}
