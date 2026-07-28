// Geração e cifragem de secrets de webhook (Etapa B — integração em lote).
//
// O plaintext NUNCA é persistido em claro nem logado: só a forma CIFRADA (reversível, AES-256-GCM)
// e a máscara de exibição são persistidas. A cifragem (em vez de hash) existe porque a assinatura
// HMAC de cada entrega precisa do PLAINTEXT original — um receptor que copiou o secret uma única
// vez da UI só consegue validar `HMAC-SHA256(plaintext, ...)` se o servidor conseguir decifrar de
// volta o mesmo plaintext no momento de assinar (ver server/integrations/signature.js).
//
// Este módulo é PURO: a chave de cifragem (`key`, 32 bytes) é sempre recebida por parâmetro — nunca
// lida de `process.env` aqui (isso é responsabilidade de `server/integrations/config.js`).

import { randomBytes, createHash, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';

const PREFIX = 'whsec_';
const ENC_VERSION = 'v1';
const ENC_ALGO = 'aes-256-gcm';
const IV_BYTES = 12;

function sha256Hex(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// Cifra `plaintext` com AES-256-GCM usando `key` (Buffer de 32 bytes). Formato compacto,
// auto-descritivo e versionado: `v1.<ivBase64>.<authTagBase64>.<ciphertextBase64>`.
export function encryptSecret(plaintext, key) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ENC_ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENC_VERSION, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join('.');
}

// Decifra o resultado de `encryptSecret`. Lança se a chave estiver errada, o texto tiver sido
// adulterado (auth tag não bate) ou o formato for inválido — chamadores devem capturar o erro.
export function decryptSecret(ciphertext, key) {
  const parts = String(ciphertext || '').split('.');
  if (parts.length !== 4 || parts[0] !== ENC_VERSION) {
    throw new Error('Formato de secret cifrado inválido');
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  const decipher = createDecipheriv(ENC_ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

// Gera um novo secret: plaintext (para exibir uma única vez ao usuário), encrypted (persistido em
// secret_encrypted — reversível com `key`) e masked (persistido em secret_masked). plaintext =
// whsec_ + base64url de 32 bytes aleatórios cripto-seguros (randomBytes) — nunca persistido cru.
export function generateSecret(key) {
  const plaintext = PREFIX + randomBytes(32).toString('base64url');
  return {
    plaintext,
    encrypted: encryptSecret(plaintext, key),
    masked: maskFromPlaintext(plaintext),
  };
}

// sha256(plaintext) em hex. Mantido por compatibilidade/uso auxiliar (ex.: comparação fora de
// banda); NÃO é mais o que se persiste em `tenant_integrations` (ver `secret_encrypted`).
export function hashSecret(plaintext) {
  return sha256Hex(plaintext);
}

// `whsec_••••` + últimos 4 chars do plaintext — nunca revela o segredo completo.
export function maskFromPlaintext(plaintext) {
  return `${PREFIX}••••${plaintext.slice(-4)}`;
}

// Compara plaintext a um hash sha256 com timingSafeEqual sobre os digests (evita timing attack).
// Mantido por compatibilidade; não usado no fluxo principal (que agora decifra e compara secrets
// via HMAC, não via hash).
export function verifySecret(plaintext, hash) {
  const candidate = Buffer.from(hashSecret(plaintext), 'hex');
  const stored = Buffer.from(String(hash || ''), 'hex');
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}
