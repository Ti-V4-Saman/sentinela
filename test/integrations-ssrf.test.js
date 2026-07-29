import { describe, it, expect } from 'vitest';
import {
  validateUrlSyntax,
  isBlockedIp,
  assertSafeUrl,
  checkRedirectTarget,
  MAX_REDIRECTS,
  safeFetchGuard,
} from '../server/integrations/ssrf.js';

// Resolver mock: recebe hostname, devolve o array no formato de dns.promises.lookup(host,{all:true}).
function mockResolver(map) {
  return async (hostname) => {
    if (!(hostname in map)) throw new Error(`sem mock de DNS para ${hostname}`);
    const entry = map[hostname];
    if (entry instanceof Error) throw entry;
    return entry;
  };
}

describe('ssrf — validateUrlSyntax', () => {
  it('bloqueia http:// no modo estrito (allowHttp: false)', () => {
    const r = validateUrlSyntax('http://x.com', { allowHttp: false });
    expect(r.ok).toBe(false);
  });

  it('permite http:// quando allowHttp: true', () => {
    const r = validateUrlSyntax('http://x.com', { allowHttp: true });
    expect(r.ok).toBe(true);
  });

  it('permite https:// no modo estrito', () => {
    const r = validateUrlSyntax('https://example.com', { allowHttp: false });
    expect(r.ok).toBe(true);
  });

  it('bloqueia URL maior que MAX_URL_LEN (2048)', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(2048);
    expect(longUrl.length).toBeGreaterThan(2048);
    const r = validateUrlSyntax(longUrl, { allowHttp: false });
    expect(r.ok).toBe(false);
  });

  it('bloqueia URL não parseável', () => {
    const r = validateUrlSyntax('not a url', { allowHttp: false });
    expect(r.ok).toBe(false);
  });

  it('bloqueia URL com credenciais embutidas', () => {
    const r = validateUrlSyntax('https://user:pass@example.com', { allowHttp: false });
    expect(r.ok).toBe(false);
  });

  it('bloqueia protocolo diferente de http/https (ex.: ftp)', () => {
    const r = validateUrlSyntax('ftp://example.com', { allowHttp: false });
    expect(r.ok).toBe(false);
  });
});

describe('ssrf — isBlockedIp (IPv4)', () => {
  it('bloqueia loopback 127.0.0.1 e 127.0.0.5', () => {
    expect(isBlockedIp('127.0.0.1')).toBe(true);
    expect(isBlockedIp('127.0.0.5')).toBe(true);
  });

  it('bloqueia 0.0.0.0 e faixa 0.0.0.0/8', () => {
    expect(isBlockedIp('0.0.0.0')).toBe(true);
    expect(isBlockedIp('0.1.2.3')).toBe(true);
  });

  it('bloqueia privadas 10/8, 172.16/12, 192.168/16', () => {
    expect(isBlockedIp('10.1.2.3')).toBe(true);
    expect(isBlockedIp('172.16.0.1')).toBe(true);
    expect(isBlockedIp('172.31.255.255')).toBe(true);
    expect(isBlockedIp('192.168.1.1')).toBe(true);
  });

  it('boundary do /12: 172.15.x e 172.32.x NÃO são bloqueados', () => {
    expect(isBlockedIp('172.15.255.255')).toBe(false);
    expect(isBlockedIp('172.32.0.1')).toBe(false);
  });

  it('boundary do 192.168/16: 192.169.x NÃO é bloqueado', () => {
    expect(isBlockedIp('192.169.0.1')).toBe(false);
  });

  it('bloqueia CGNAT 100.64.0.0/10', () => {
    expect(isBlockedIp('100.64.0.1')).toBe(true);
  });

  it('boundary do /10 CGNAT: 100.63.x e 100.128.x NÃO são bloqueados', () => {
    expect(isBlockedIp('100.63.255.255')).toBe(false);
    expect(isBlockedIp('100.128.0.1')).toBe(false);
  });

  it('bloqueia link-local 169.254.0.0/16 incl. metadata 169.254.169.254', () => {
    expect(isBlockedIp('169.254.169.254')).toBe(true);
    expect(isBlockedIp('169.254.0.1')).toBe(true);
  });

  it('bloqueia broadcast 255.255.255.255', () => {
    expect(isBlockedIp('255.255.255.255')).toBe(true);
  });

  it('permite IP público comum', () => {
    expect(isBlockedIp('93.184.216.34')).toBe(false);
    expect(isBlockedIp('8.8.8.8')).toBe(false);
  });
});

describe('ssrf — isBlockedIp (IPv6)', () => {
  it('bloqueia ::1 (loopback) e :: (unspecified)', () => {
    expect(isBlockedIp('::1')).toBe(true);
    expect(isBlockedIp('::')).toBe(true);
  });

  it('bloqueia link-local fe80::/10', () => {
    expect(isBlockedIp('fe80::1')).toBe(true);
  });

  it('bloqueia ULA fc00::/7', () => {
    expect(isBlockedIp('fc00::1')).toBe(true);
    expect(isBlockedIp('fd00::1')).toBe(true);
  });

  it('bloqueia IPv4-mapped ::ffff:127.0.0.1 (loopback embutido)', () => {
    expect(isBlockedIp('::ffff:127.0.0.1')).toBe(true);
  });

  it('bloqueia IPv4-mapped com IP privado embutido', () => {
    expect(isBlockedIp('::ffff:10.0.0.5')).toBe(true);
    expect(isBlockedIp('::ffff:169.254.169.254')).toBe(true);
  });

  it('permite IPv4-mapped com IP público embutido', () => {
    expect(isBlockedIp('::ffff:93.184.216.34')).toBe(false);
  });

  it('permite IPv6 público', () => {
    expect(isBlockedIp('2606:2800::1')).toBe(false);
  });

  it('fail-closed: string inválida ou não-IP é bloqueada', () => {
    expect(isBlockedIp('not-an-ip')).toBe(true);
    expect(isBlockedIp('')).toBe(true);
    expect(isBlockedIp(null)).toBe(true);
    expect(isBlockedIp(undefined)).toBe(true);
  });
});

describe('ssrf — assertSafeUrl', () => {
  it('bloqueia https://localhost (resolver -> 127.0.0.1)', async () => {
    const resolver = mockResolver({ localhost: [{ address: '127.0.0.1', family: 4 }] });
    const r = await assertSafeUrl('https://localhost', { allowHttp: false, resolver });
    expect(r.ok).toBe(false);
  });

  it('bloqueia IP literal https://127.0.0.1 direto (sem precisar resolver)', async () => {
    const r = await assertSafeUrl('https://127.0.0.1', { allowHttp: false, resolver: mockResolver({}) });
    expect(r.ok).toBe(false);
  });

  it('bloqueia IP literal https://127.0.0.5', async () => {
    const r = await assertSafeUrl('https://127.0.0.5', { allowHttp: false, resolver: mockResolver({}) });
    expect(r.ok).toBe(false);
  });

  it('bloqueia IP literal https://0.0.0.0', async () => {
    const r = await assertSafeUrl('https://0.0.0.0', { allowHttp: false, resolver: mockResolver({}) });
    expect(r.ok).toBe(false);
  });

  it('bloqueia IP literal https://10.1.2.3', async () => {
    const r = await assertSafeUrl('https://10.1.2.3', { allowHttp: false, resolver: mockResolver({}) });
    expect(r.ok).toBe(false);
  });

  it('bloqueia IP literal https://172.16.0.1', async () => {
    const r = await assertSafeUrl('https://172.16.0.1', { allowHttp: false, resolver: mockResolver({}) });
    expect(r.ok).toBe(false);
  });

  it('bloqueia IP literal https://172.31.255.255', async () => {
    const r = await assertSafeUrl('https://172.31.255.255', { allowHttp: false, resolver: mockResolver({}) });
    expect(r.ok).toBe(false);
  });

  it('bloqueia IP literal https://192.168.1.1', async () => {
    const r = await assertSafeUrl('https://192.168.1.1', { allowHttp: false, resolver: mockResolver({}) });
    expect(r.ok).toBe(false);
  });

  it('bloqueia IP literal https://100.64.0.1', async () => {
    const r = await assertSafeUrl('https://100.64.0.1', { allowHttp: false, resolver: mockResolver({}) });
    expect(r.ok).toBe(false);
  });

  it('bloqueia IP literal https://169.254.169.254 (metadata)', async () => {
    const r = await assertSafeUrl('https://169.254.169.254', { allowHttp: false, resolver: mockResolver({}) });
    expect(r.ok).toBe(false);
  });

  it('bloqueia IP literal https://[::1]', async () => {
    const r = await assertSafeUrl('https://[::1]', { allowHttp: false, resolver: mockResolver({}) });
    expect(r.ok).toBe(false);
  });

  it('bloqueia IP literal https://[fe80::1]', async () => {
    const r = await assertSafeUrl('https://[fe80::1]', { allowHttp: false, resolver: mockResolver({}) });
    expect(r.ok).toBe(false);
  });

  it('bloqueia IP literal https://[fc00::1]', async () => {
    const r = await assertSafeUrl('https://[fc00::1]', { allowHttp: false, resolver: mockResolver({}) });
    expect(r.ok).toBe(false);
  });

  it('bloqueia IP literal https://[::ffff:127.0.0.1] (mapped loopback)', async () => {
    const r = await assertSafeUrl('https://[::ffff:127.0.0.1]', { allowHttp: false, resolver: mockResolver({}) });
    expect(r.ok).toBe(false);
  });

  it('bloqueia URL > 2048 chars', async () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(2048);
    const r = await assertSafeUrl(longUrl, { allowHttp: false, resolver: mockResolver({}) });
    expect(r.ok).toBe(false);
  });

  it('bloqueia hostname público cujo DNS resolve para IP privado (example.com -> 10.0.0.5)', async () => {
    const resolver = mockResolver({ 'example.com': [{ address: '10.0.0.5', family: 4 }] });
    const r = await assertSafeUrl('https://example.com', { allowHttp: false, resolver });
    expect(r.ok).toBe(false);
  });

  it('permite hostname público com DNS resolvendo para IP público', async () => {
    const resolver = mockResolver({ 'example.com': [{ address: '93.184.216.34', family: 4 }] });
    const r = await assertSafeUrl('https://example.com', { allowHttp: false, resolver });
    expect(r.ok).toBe(true);
    expect(r.ips).toContain('93.184.216.34');
  });

  it('bloqueia (fail-closed) se o resolver lançar erro', async () => {
    const resolver = mockResolver({ 'example.com': new Error('DNS falhou') });
    const r = await assertSafeUrl('https://example.com', { allowHttp: false, resolver });
    expect(r.ok).toBe(false);
  });

  it('bloqueia se QUALQUER um dos IPs resolvidos for privado (multi-A record)', async () => {
    const resolver = mockResolver({
      'example.com': [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ],
    });
    const r = await assertSafeUrl('https://example.com', { allowHttp: false, resolver });
    expect(r.ok).toBe(false);
  });

  it('permite IPv6 público via resolver', async () => {
    const resolver = mockResolver({ 'example.com': [{ address: '2606:2800::1', family: 6 }] });
    const r = await assertSafeUrl('https://example.com', { allowHttp: false, resolver });
    expect(r.ok).toBe(true);
  });
});

describe('ssrf — checkRedirectTarget', () => {
  it('retorna false para redirect a metadata 169.254.169.254', async () => {
    const ok = await checkRedirectTarget('http://169.254.169.254/latest/meta-data', {
      allowHttp: true,
      resolver: mockResolver({}),
    });
    expect(ok).toBe(false);
  });

  it('retorna true para redirect seguro a IP público via DNS', async () => {
    const resolver = mockResolver({ 'example.com': [{ address: '93.184.216.34', family: 4 }] });
    const ok = await checkRedirectTarget('https://example.com/next', { allowHttp: false, resolver });
    expect(ok).toBe(true);
  });

  it('retorna false para URL sintaticamente inválida', async () => {
    const ok = await checkRedirectTarget('not a url', { allowHttp: false, resolver: mockResolver({}) });
    expect(ok).toBe(false);
  });
});

describe('ssrf — constantes', () => {
  it('MAX_REDIRECTS = 3', () => {
    expect(MAX_REDIRECTS).toBe(3);
  });
});

describe('ssrf — safeFetchGuard', () => {
  it('expõe maxRedirects === MAX_REDIRECTS (3)', () => {
    const guard = safeFetchGuard({ resolver: mockResolver({}) });
    expect(guard.maxRedirects).toBe(3);
  });

  it('checkRedirectTarget do guard retorna false para metadata 169.254.169.254', async () => {
    const guard = safeFetchGuard({ allowHttp: true, resolver: mockResolver({}) });
    const ok = await guard.checkRedirectTarget('http://169.254.169.254/latest/meta-data');
    expect(ok).toBe(false);
  });

  it('checkRedirectTarget do guard retorna true para IP público via resolver', async () => {
    const resolver = mockResolver({ 'example.com': [{ address: '93.184.216.34', family: 4 }] });
    const guard = safeFetchGuard({ resolver });
    const ok = await guard.checkRedirectTarget('https://example.com');
    expect(ok).toBe(true);
  });
});
