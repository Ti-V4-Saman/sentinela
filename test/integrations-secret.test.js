import { describe, it, expect } from 'vitest';
import {
  generateSecret, hashSecret, maskFromPlaintext, verifySecret, encryptSecret, decryptSecret,
} from '../server/integrations/secret.js';

// Chave fixa de teste (32 bytes) — nunca usar em produção.
const TEST_KEY = Buffer.from('0'.repeat(64), 'hex');
const OTHER_KEY = Buffer.from('1'.repeat(64), 'hex');

describe('secret — geração cripto-segura, cifragem e máscara', () => {
  it('gera plaintext com prefixo whsec_ e entropia de pelo menos 32 bytes', () => {
    const { plaintext } = generateSecret(TEST_KEY);
    expect(plaintext.startsWith('whsec_')).toBe(true);
    const b64 = plaintext.slice('whsec_'.length);
    const bytes = Buffer.from(b64, 'base64url');
    expect(bytes.length).toBeGreaterThanOrEqual(32);
  });

  it('generateSecret retorna encrypted (não hash) e ele decifra de volta ao plaintext', () => {
    const { plaintext, encrypted } = generateSecret(TEST_KEY);
    expect(typeof encrypted).toBe('string');
    expect(encrypted).not.toBe(plaintext);
    expect(decryptSecret(encrypted, TEST_KEY)).toBe(plaintext);
  });

  it('masked revela no máximo os 4 últimos chars e não contém o plaintext', () => {
    const { plaintext, masked } = generateSecret(TEST_KEY);
    expect(masked).toBe(maskFromPlaintext(plaintext));
    expect(masked.startsWith('whsec_••••')).toBe(true);
    expect(masked.endsWith(plaintext.slice(-4))).toBe(true);
    expect(masked).not.toContain(plaintext);
    expect(masked.length).toBeLessThan(plaintext.length);
  });

  it('dois secrets gerados são diferentes', () => {
    const a = generateSecret(TEST_KEY);
    const b = generateSecret(TEST_KEY);
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.encrypted).not.toBe(b.encrypted);
    expect(a.masked).not.toBe(b.masked);
  });

  it('verifySecret (auxiliar legado) retorna true para par correto e false para incorreto', () => {
    const { plaintext, encrypted } = generateSecret(TEST_KEY);
    void encrypted;
    const hash = hashSecret(plaintext);
    expect(verifySecret(plaintext, hash)).toBe(true);
    const other = generateSecret(TEST_KEY);
    expect(verifySecret(other.plaintext, hash)).toBe(false);
  });

  it('verifySecret é timing-safe: hash de tamanho diferente retorna false sem lançar', () => {
    const { plaintext } = generateSecret(TEST_KEY);
    expect(() => verifySecret(plaintext, 'abc123')).not.toThrow();
    expect(verifySecret(plaintext, 'abc123')).toBe(false);
  });

  it('hashSecret é determinístico e sensível ao conteúdo', () => {
    expect(hashSecret('whsec_abc')).toBe(hashSecret('whsec_abc'));
    expect(hashSecret('whsec_abc')).not.toBe(hashSecret('whsec_abd'));
  });
});

describe('encryptSecret/decryptSecret — round-trip AES-256-GCM', () => {
  it('round-trip: decryptSecret(encryptSecret(p,k),k) === p', () => {
    const plaintext = 'whsec_valor-secreto-de-teste-123456';
    const ciphertext = encryptSecret(plaintext, TEST_KEY);
    expect(decryptSecret(ciphertext, TEST_KEY)).toBe(plaintext);
  });

  it('ciphertext é diferente do plaintext e não o contém', () => {
    const plaintext = 'whsec_valor-secreto-de-teste-123456';
    const ciphertext = encryptSecret(plaintext, TEST_KEY);
    expect(ciphertext).not.toBe(plaintext);
    expect(ciphertext).not.toContain(plaintext);
  });

  it('duas cifragens do mesmo plaintext produzem ciphertexts diferentes (IV aleatório)', () => {
    const plaintext = 'whsec_valor-secreto-de-teste-123456';
    const a = encryptSecret(plaintext, TEST_KEY);
    const b = encryptSecret(plaintext, TEST_KEY);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, TEST_KEY)).toBe(plaintext);
    expect(decryptSecret(b, TEST_KEY)).toBe(plaintext);
  });

  it('decifrar com a chave ERRADA lança (nunca retorna dado adulterado silenciosamente)', () => {
    const plaintext = 'whsec_valor-secreto-de-teste-123456';
    const ciphertext = encryptSecret(plaintext, TEST_KEY);
    expect(() => decryptSecret(ciphertext, OTHER_KEY)).toThrow();
  });

  it('ciphertext adulterado (tamperado) lança na decifragem (auth tag não bate)', () => {
    const plaintext = 'whsec_valor-secreto-de-teste-123456';
    const ciphertext = encryptSecret(plaintext, TEST_KEY);
    const parts = ciphertext.split('.');
    // Corrompe um byte do corpo cifrado (última parte).
    const tampered = [...parts];
    tampered[3] = Buffer.from('adulterado-xyz').toString('base64');
    expect(() => decryptSecret(tampered.join('.'), TEST_KEY)).toThrow();
  });

  it('formato do ciphertext é versionado (v1.iv.tag.ct)', () => {
    const ciphertext = encryptSecret('whsec_abc', TEST_KEY);
    const parts = ciphertext.split('.');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
  });
});
