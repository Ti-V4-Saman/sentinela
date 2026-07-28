// Geração, hash e mascaramento de secrets de webhook (Etapa B — integração em lote).
// O plaintext NUNCA é persistido nem logado: só hash (sha256) e máscara de exibição.

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const PREFIX = 'whsec_';

function sha256Hex(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// Gera um novo secret: plaintext (para exibir uma única vez ao usuário), hash (persistido em
// secret_hash) e masked (persistido em secret_masked). plaintext = whsec_ + base64url de 32 bytes
// aleatórios cripto-seguros (randomBytes) — nunca persistido cru.
export function generateSecret() {
  const plaintext = PREFIX + randomBytes(32).toString('base64url');
  return {
    plaintext,
    hash: hashSecret(plaintext),
    masked: maskFromPlaintext(plaintext),
  };
}

// sha256(plaintext) em hex.
export function hashSecret(plaintext) {
  return sha256Hex(plaintext);
}

// `whsec_••••` + últimos 4 chars do plaintext — nunca revela o segredo completo.
export function maskFromPlaintext(plaintext) {
  return `${PREFIX}••••${plaintext.slice(-4)}`;
}

// Compara plaintext ao hash persistido com timingSafeEqual sobre os digests (evita timing attack).
export function verifySecret(plaintext, hash) {
  const candidate = Buffer.from(hashSecret(plaintext), 'hex');
  const stored = Buffer.from(String(hash || ''), 'hex');
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}
