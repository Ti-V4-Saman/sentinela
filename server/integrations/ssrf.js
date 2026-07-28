// Defesa SSRF para a integração por webhook em lote (Etapa B).
//
// Toda URL fornecida pelo tenant (config da integração, teste de conexão, redirect de entrega)
// passa por aqui ANTES de qualquer request de rede sair do servidor. Fail-closed: qualquer erro
// de parse, família de IP desconhecida ou falha do resolver DNS é tratado como bloqueado.
//
// O resolver DNS é injetável (parâmetro `resolver`) para que os testes nunca toquem a rede real —
// em produção o chamador passa o default (`dns.promises.lookup(host, { all: true })`).

import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

export const MAX_URL_LEN = 2048;
export const MAX_REDIRECTS = 3;

// Portas não-padrão: permitidas propositalmente (não fazem parte da defesa SSRF — o alvo já
// precisa passar por validação de IP/DNS; restringir portas aqui só atrapalharia ambientes de
// teste/homolog que expõem o mock em porta alta). Documentado conforme pedido na spec.

function resolveDefault(hostname) {
  return dnsLookup(hostname, { all: true });
}

// Valida forma da URL: comprimento, parseabilidade, protocolo e ausência de credenciais.
// Não faz nenhuma resolução de rede.
export function validateUrlSyntax(url, { allowHttp = false } = {}) {
  if (typeof url !== 'string' || url.length === 0) {
    return { ok: false, reason: 'url_vazia' };
  }
  if (url.length > MAX_URL_LEN) {
    return { ok: false, reason: 'url_excede_tamanho_maximo' };
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'url_invalida' };
  }

  const allowedProtocols = allowHttp === true ? ['https:', 'http:'] : ['https:'];
  if (!allowedProtocols.includes(parsed.protocol)) {
    return { ok: false, reason: 'protocolo_nao_permitido' };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'credenciais_na_url' };
  }

  return { ok: true };
}

function ipv4OctetsToInt(octets) {
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

function parseIpv4(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const octets = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

function inIpv4Range(ip, base, prefixLen) {
  const ipOctets = parseIpv4(ip);
  const baseOctets = parseIpv4(base);
  if (!ipOctets || !baseOctets) return false;
  const ipInt = ipv4OctetsToInt(ipOctets);
  const baseInt = ipv4OctetsToInt(baseOctets);
  const mask = prefixLen === 0 ? 0 : (0xffffffff << (32 - prefixLen)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

// Bloqueia IPv4 em: loopback 127/8, 0/8 (incl. 0.0.0.0), privadas 10/8 172.16/12 192.168/16,
// CGNAT 100.64/10, link-local 169.254/16 (incl. metadata 169.254.169.254), broadcast.
function isBlockedIpv4(ip) {
  if (!parseIpv4(ip)) return true; // fail-closed: não é um IPv4 válido
  if (inIpv4Range(ip, '127.0.0.0', 8)) return true;
  if (inIpv4Range(ip, '0.0.0.0', 8)) return true;
  if (inIpv4Range(ip, '10.0.0.0', 8)) return true;
  if (inIpv4Range(ip, '172.16.0.0', 12)) return true;
  if (inIpv4Range(ip, '192.168.0.0', 16)) return true;
  if (inIpv4Range(ip, '100.64.0.0', 10)) return true;
  if (inIpv4Range(ip, '169.254.0.0', 16)) return true;
  if (ip === '255.255.255.255') return true;
  return false;
}

// Expande um IPv6 para os 8 grupos hex completos (sem `::`), como array de strings de 4 dígitos.
function expandIpv6(ip) {
  let addr = ip;
  // remove zona (%eth0) se presente
  const pct = addr.indexOf('%');
  if (pct !== -1) addr = addr.slice(0, pct);

  if (addr.includes('.')) {
    // possível forma mista (ex.: ::ffff:127.0.0.1) — converte a cauda IPv4 em dois grupos hex
    const lastColon = addr.lastIndexOf(':');
    const v4part = addr.slice(lastColon + 1);
    const v4octets = parseIpv4(v4part);
    if (!v4octets) return null;
    const hi = ((v4octets[0] << 8) | v4octets[1]).toString(16);
    const lo = ((v4octets[2] << 8) | v4octets[3]).toString(16);
    addr = addr.slice(0, lastColon + 1) + hi + ':' + lo;
  }

  let head = [];
  let tail = [];
  if (addr.includes('::')) {
    const [h, t] = addr.split('::');
    head = h ? h.split(':') : [];
    tail = t ? t.split(':') : [];
  } else {
    head = addr.split(':');
    tail = [];
  }

  const missing = 8 - (head.length + tail.length);
  if (missing < 0) return null;
  const fill = new Array(missing).fill('0');
  const groups = [...head, ...fill, ...tail];
  if (groups.length !== 8) return null;

  return groups.map((g) => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    return g.toLowerCase().padStart(4, '0');
  });
}

function ipv4MappedToDotted(groups) {
  const hi = parseInt(groups[6], 16);
  const lo = parseInt(groups[7], 16);
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join('.');
}

// Bloqueia IPv6 em: ::1, :: (unspecified), fe80::/10 (link-local), fc00::/7 (ULA),
// IPv4-mapped/compatible (extrai o IPv4 embutido e reaplica as regras de IPv4).
function isBlockedIpv6(ip) {
  const groups = expandIpv6(ip);
  if (!groups) return true; // fail-closed: não é um IPv6 válido

  const allZero = groups.every((g) => g === '0000');
  if (allZero) return true; // :: (unspecified)

  const isLoopback = groups.slice(0, 7).every((g) => g === '0000') && groups[7] === '0001';
  if (isLoopback) return true; // ::1

  const firstGroup = parseInt(groups[0], 16);
  // fe80::/10 -> primeiros 10 bits = 1111 1110 10 -> grupo0 & 0xffc0 === 0xfe80
  if ((firstGroup & 0xffc0) === 0xfe80) return true;
  // fc00::/7 -> primeiros 7 bits = 1111 110 -> grupo0 & 0xfe00 === 0xfc00
  if ((firstGroup & 0xfe00) === 0xfc00) return true;

  // IPv4-mapped ::ffff:0:0/96 -> primeiros 6 grupos zero, grupo6 = ffff
  const isV4Mapped =
    groups.slice(0, 5).every((g) => g === '0000') && groups[5] === 'ffff';
  if (isV4Mapped) {
    const embedded = ipv4MappedToDotted(groups);
    return isBlockedIpv4(embedded);
  }

  // IPv4-compatible (deprecated) ::a.b.c.d/96 -> primeiros 6 grupos zero, grupo5 = 0000,
  // e não é `::` nem `::1` (já tratados acima).
  const isV4Compatible = groups.slice(0, 6).every((g) => g === '0000');
  if (isV4Compatible) {
    const embedded = ipv4MappedToDotted(['0000', '0000', '0000', '0000', '0000', '0000', groups[6], groups[7]]);
    return isBlockedIpv4(embedded);
  }

  return false;
}

// Callers devem passar IPs já resolvidos (literais de URL ou respostas de DNS) — esta função não
// resolve hostname. Retorna true (bloqueado) para qualquer entrada que não seja um IP válido,
// fail-closed.
export function isBlockedIp(ip) {
  if (typeof ip !== 'string' || ip.length === 0) return true;
  const family = isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  return true; // família desconhecida -> fail-closed
}

function stripBrackets(hostname) {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

// Valida sintaxe + resolve o host (se necessário) e garante que TODOS os IPs resultantes sejam
// públicos. `resolver` é injetável — testes passam um mock; produção usa o default
// (dns.promises.lookup com { all: true }).
export async function assertSafeUrl(url, { allowHttp = false, resolver = resolveDefault } = {}) {
  const syntax = validateUrlSyntax(url, { allowHttp });
  if (!syntax.ok) return { ok: false, reason: syntax.reason };

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'url_invalida' };
  }

  const hostname = stripBrackets(parsed.hostname);

  if (isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      return { ok: false, reason: 'ip_bloqueado' };
    }
    return { ok: true, ips: [hostname] };
  }

  let records;
  try {
    records = await resolver(hostname);
  } catch {
    return { ok: false, reason: 'falha_resolucao_dns' };
  }

  if (!Array.isArray(records) || records.length === 0) {
    return { ok: false, reason: 'dns_sem_resultado' };
  }

  const ips = records.map((r) => (r && typeof r === 'object' ? r.address : r)).filter(Boolean);
  if (ips.length === 0) {
    return { ok: false, reason: 'dns_sem_resultado' };
  }

  for (const ip of ips) {
    if (isBlockedIp(ip)) {
      return { ok: false, reason: 'ip_resolvido_bloqueado' };
    }
  }

  return { ok: true, ips };
}

// Usado a cada salto de redirect durante a entrega (até MAX_REDIRECTS). Mesma validação de
// assertSafeUrl, mas retorna boolean simples para uso direto em loop de follow-redirect.
export async function checkRedirectTarget(locationUrl, { allowHttp = false, resolver = resolveDefault } = {}) {
  const result = await assertSafeUrl(locationUrl, { allowHttp, resolver });
  return result.ok === true;
}
