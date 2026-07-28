import { describe, it, expect } from 'vitest';
import { generateSecret, hashSecret, maskFromPlaintext, verifySecret } from '../server/integrations/secret.js';

describe('secret — geração cripto-segura, hash e máscara', () => {
  it('gera plaintext com prefixo whsec_ e entropia de pelo menos 32 bytes', () => {
    const { plaintext } = generateSecret();
    expect(plaintext.startsWith('whsec_')).toBe(true);
    const b64 = plaintext.slice('whsec_'.length);
    const bytes = Buffer.from(b64, 'base64url');
    expect(bytes.length).toBeGreaterThanOrEqual(32);
  });

  it('hash retornado bate com hashSecret(plaintext)', () => {
    const { plaintext, hash } = generateSecret();
    expect(hash).toBe(hashSecret(plaintext));
  });

  it('masked revela no máximo os 4 últimos chars e não contém o plaintext', () => {
    const { plaintext, masked } = generateSecret();
    expect(masked).toBe(maskFromPlaintext(plaintext));
    expect(masked.startsWith('whsec_••••')).toBe(true);
    expect(masked.endsWith(plaintext.slice(-4))).toBe(true);
    expect(masked).not.toContain(plaintext);
    expect(masked.length).toBeLessThan(plaintext.length);
  });

  it('dois secrets gerados são diferentes', () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.hash).not.toBe(b.hash);
    expect(a.masked).not.toBe(b.masked);
  });

  it('verifySecret retorna true para par correto e false para incorreto', () => {
    const { plaintext, hash } = generateSecret();
    expect(verifySecret(plaintext, hash)).toBe(true);
    const other = generateSecret();
    expect(verifySecret(other.plaintext, hash)).toBe(false);
  });

  it('verifySecret é timing-safe: hash de tamanho diferente retorna false sem lançar', () => {
    const { plaintext } = generateSecret();
    expect(() => verifySecret(plaintext, 'abc123')).not.toThrow();
    expect(verifySecret(plaintext, 'abc123')).toBe(false);
  });

  it('hashSecret é determinístico e sensível ao conteúdo', () => {
    expect(hashSecret('whsec_abc')).toBe(hashSecret('whsec_abc'));
    expect(hashSecret('whsec_abc')).not.toBe(hashSecret('whsec_abd'));
  });
});
