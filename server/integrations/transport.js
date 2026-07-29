// Transporte HTTP seguro contra DNS-rebinding (TOCTOU) para a entrega de webhooks em lote
// (Etapa B — hardening R1).
//
// Problema que este módulo fecha: `assertSafeUrl(url)` (ssrf.js) resolve o DNS e valida os IPs
// resultantes, mas um `fetch(url)` chamado em seguida faz a SUA PRÓPRIA resolução DNS
// independente — entre a validação e a conexão real, um atacante com controle do DNS pode trocar
// a resposta (rebinding) para um IP privado/loopback/metadata. A validação vê um IP público; a
// conexão de fato usa outro.
//
// Invariante central: a conexão TCP usa EXATAMENTE o IP já validado por `assertSafeUrl`, nunca
// uma segunda resolução não controlada. Isso é obtido passando a opção `lookup` do
// `https.request`/`http.request` do Node: essa opção intercepta a resolução de hostname do
// próprio cliente HTTP e a substitui por um callback síncrono que devolve o IP já validado — o
// Node NUNCA chama `dns.lookup` internamente quando essa opção é fornecida.
//
// `servername` (SNI) e o header `Host` continuam sendo o HOSTNAME ORIGINAL (nunca o IP) — isso é
// necessário para: (a) o servidor de destino rotear a requisição corretamente (SNI/Host-based
// virtual hosting); (b) a validação do certificado TLS (`rejectUnauthorized: true`, NUNCA
// desabilitado) checar o hostname esperado, não o IP.
//
// Redirects NUNCA são seguidos automaticamente pelo cliente HTTP (`https.request` já não segue
// por padrão). Cada hop de redirect é revalidado do zero (nova chamada a `assertSafeUrl`) antes de
// qualquer conexão — inclusive ao mudar de hostname, o IP anterior é descartado.
//
// Nada de corpo de resposta é lido/retornado; erros são sempre códigos curtos e sanitizados.

import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { lookup as dnsLookup } from 'node:dns/promises';
import { assertSafeUrl } from './ssrf.js';

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_REDIRECTS = 3;

function defaultLookupImpl(hostname) {
  return dnsLookup(hostname, { all: true });
}

// Adapta `lookupImpl` (que devolve todos os IPs, no formato dns.promises.lookup(host,{all:true}))
// para o formato `resolver` esperado por `assertSafeUrl` (mesma assinatura — reaproveitado direto).
function buildResolver(lookupImpl) {
  return async (hostname) => lookupImpl(hostname);
}

// Faz UMA requisição HTTP para `hostname`/`port`/`path`, mas FORÇA a conexão TCP a usar
// `validatedIp` via a opção `lookup` do node:http(s). Não segue redirect. Não lê o corpo da
// resposta (só drena o stream para liberar o socket). Resolve com { statusCode, headers } ou
// rejeita com um Error cujo `.code` é um dos: 'TIMEOUT' | 'NETWORK'.
function singleRequest({
  scheme, hostname, port, connectPort, path, method, headers, body, validatedIp, ipFamily,
  timeoutMs, testCa,
}) {
  return new Promise((resolve, reject) => {
    const requestFn = scheme === 'http:' ? httpRequest : httpsRequest;
    const isDefaultPort = (scheme === 'https:' && port === 443) || (scheme === 'http:' && port === 80);

    const options = {
      protocol: scheme,
      hostname,
      servername: scheme === 'https:' ? hostname : undefined, // SNI = hostname original
      host: hostname,
      port: connectPort, // porta REAL do socket (pode ser sobrescrita só em teste)
      path,
      method,
      // Host header sempre reflete a URL ORIGINAL (porta original), nunca a porta de teste usada
      // para redirecionar o socket ao servidor local.
      headers: { ...headers, Host: isDefaultPort ? hostname : `${hostname}:${port}` },
      // Pino da conexão no IP já validado: o Node chama este callback em vez de dns.lookup real.
      // Nenhuma segunda resolução DNS ocorre. Node >=20 usa Happy Eyeballs (autoSelectFamily) por
      // padrão e chama `lookup` com `{ all: true }`, esperando um ARRAY de { address, family }
      // (mesmo formato de dns.lookup(host,{all:true})) em vez do par (address, family) legado —
      // suportamos as duas formas de chamada para robustez entre versões do Node. Desabilitamos
      // `autoSelectFamily` explicitamente: só existe UM IP pré-validado por hop (o invariante
      // central desta defesa), então não há o que "correr em paralelo" — Happy Eyeballs contra
      // múltiplos candidatos abriria uma ambiguidade sobre qual IP foi de fato validado.
      autoSelectFamily: false,
      lookup: (_hostname, opts, cb) => {
        if (opts && opts.all) return cb(null, [{ address: validatedIp, family: ipFamily }]);
        return cb(null, validatedIp, ipFamily);
      },
      rejectUnauthorized: true, // NUNCA desabilitar — valida o cert contra `servername`.
      timeout: timeoutMs,
      // `testCa` só é definido pelos testes (via __testCa em secureDeliver) para confiar no CA
      // self-signed do servidor HTTPS local de teste — em produção é sempre undefined e o Node
      // usa a cadeia de CAs do sistema normalmente.
      ...(testCa ? { ca: testCa } : {}),
    };

    let settled = false;
    const req = requestFn(options, (res) => {
      // Nunca lemos/retornamos o corpo — só drenamos para liberar o socket.
      res.on('data', () => {});
      res.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ statusCode: res.statusCode, headers: res.headers });
      });
      res.on('error', () => {
        if (settled) return;
        settled = true;
        const err = new Error('network');
        err.code = 'NETWORK';
        reject(err);
      });
    });

    req.on('timeout', () => {
      if (settled) return;
      settled = true;
      const err = new Error('timeout');
      err.code = 'TIMEOUT';
      req.destroy();
      reject(err);
    });

    req.on('error', (e) => {
      if (settled) return;
      settled = true;
      // node marca abort/timeout de formas diferentes conforme a versão; normaliza para NETWORK
      // (TIMEOUT já é tratado pelo listener 'timeout' acima).
      const err = new Error('network');
      err.code = e && e.code === 'ABORT_ERR' ? 'TIMEOUT' : 'NETWORK';
      reject(err);
    });

    if (body !== undefined && body !== null && method !== 'GET' && method !== 'HEAD') {
      req.write(body);
    }
    req.end();
  });
}

// secureDeliver({ url, method, headers, body, allowHttp, timeoutMs, maxRedirects, lookupImpl })
//   -> Promise<{ status: 'success'|'failure', http_code, duration_ms, error?, finalUrl }>
//
// Por hop: (1) valida a URL corrente via assertSafeUrl (TODOS os IPs); (2) escolhe um IP validado;
// (3) conecta pinando o socket nesse IP, com SNI/Host = hostname original e
// rejectUnauthorized:true; (4) em 3xx com Location, resolve (absoluto ou relativo) e repete desde
// (1) — o IP anterior é sempre descartado, cada hostname é revalidado do zero; (5) sucesso só em
// [200,299].
export async function secureDeliver({
  url,
  method = 'POST',
  headers = {},
  body,
  allowHttp = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  lookupImpl = defaultLookupImpl,
  // Hooks SÓ DE TESTE (nunca usados em produção — nenhum chamador de produção os passa):
  // `__testConnectOverride` aponta o socket real para um endereço diferente do IP validado, para
  // exercitar o mecanismo de handshake TLS/SNI/Host contra um servidor local (127.0.0.1) SEM
  // enfraquecer a validação SSRF real (que continua rodando normalmente sobre o IP retornado por
  // `lookupImpl`). `__testPortOverride` (opcional) permite também redirecionar a PORTA real do
  // socket (ex.: servidor de teste em porta aleatória), mantendo `port` da URL original só para
  // fins de SNI/Host/validação. `__testCa` injeta um CA extra confiável (ex.: o self-signed do
  // servidor de teste) SEM tocar `rejectUnauthorized` (permanece sempre true). Por padrão os três
  // são no-op — o socket conecta exatamente no IP:porta validados e usa a cadeia de CAs padrão do
  // sistema.
  __testConnectOverride,
  __testPortOverride,
  __testCa,
} = {}) {
  const startedAt = Date.now();
  const resolver = buildResolver(lookupImpl);

  let currentUrl = url;
  let redirects = 0;

  for (;;) {
    const check = await assertSafeUrl(currentUrl, { allowHttp, resolver });
    if (!check.ok) {
      // Hop inicial (redirects === 0) usa SSRF_BLOCKED:<reason> (mesmo código do alvo direto);
      // hops de redirect usam REDIRECT_BLOCKED — mesma distinção do caminho legado
      // (fetchImpl/checkRedirectTarget) em delivery.js, mantida para compatibilidade de contrato.
      return {
        status: 'failure', http_code: null, duration_ms: Date.now() - startedAt,
        error: redirects === 0 ? `SSRF_BLOCKED:${check.reason}` : 'REDIRECT_BLOCKED',
        finalUrl: currentUrl,
      };
    }

    const validatedIp = check.ips[0];
    const connectIp = typeof __testConnectOverride === 'function'
      ? __testConnectOverride(validatedIp, currentUrl)
      : validatedIp;
    const ipFamily = connectIp.includes(':') ? 6 : 4;

    let parsed;
    try {
      parsed = new URL(currentUrl);
    } catch {
      return {
        status: 'failure', http_code: null, duration_ms: Date.now() - startedAt,
        error: 'SSRF_BLOCKED:url_invalida', finalUrl: currentUrl,
      };
    }

    const hostname = parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
      ? parsed.hostname.slice(1, -1)
      : parsed.hostname;
    const scheme = parsed.protocol; // 'https:' ou 'http:' (já validado por assertSafeUrl)
    const port = parsed.port ? Number(parsed.port) : (scheme === 'https:' ? 443 : 80);
    const connectPort = typeof __testPortOverride === 'function'
      ? __testPortOverride(port, currentUrl)
      : port;
    const path = `${parsed.pathname}${parsed.search}`;

    let response;
    try {
      // eslint-disable-next-line no-await-in-loop
      response = await singleRequest({
        scheme, hostname, port, connectPort, path, method, headers, body,
        validatedIp: connectIp, ipFamily, timeoutMs, testCa: __testCa,
      });
    } catch (e) {
      return {
        status: 'failure', http_code: null, duration_ms: Date.now() - startedAt,
        error: e && e.code === 'TIMEOUT' ? 'TIMEOUT' : 'NETWORK', finalUrl: currentUrl,
      };
    }

    const status = response.statusCode;

    if (status >= 300 && status < 400) {
      const location = response.headers && response.headers.location;
      if (!location) {
        return {
          status: 'failure', http_code: status, duration_ms: Date.now() - startedAt,
          error: 'REDIRECT_BLOCKED', finalUrl: currentUrl,
        };
      }
      redirects += 1;
      if (redirects > maxRedirects) {
        return {
          status: 'failure', http_code: status, duration_ms: Date.now() - startedAt,
          error: 'TOO_MANY_REDIRECTS', finalUrl: currentUrl,
        };
      }
      let resolvedLocation;
      try {
        resolvedLocation = new URL(location, currentUrl).toString();
      } catch {
        return {
          status: 'failure', http_code: status, duration_ms: Date.now() - startedAt,
          error: 'REDIRECT_BLOCKED', finalUrl: currentUrl,
        };
      }
      // Revalida do zero no topo do loop (novo hostname => novo resolver => novo IP validado;
      // o IP anterior nunca é reaproveitado).
      currentUrl = resolvedLocation;
      continue;
    }

    const durationMs = Date.now() - startedAt;
    if (status >= 200 && status <= 299) {
      return { status: 'success', http_code: status, duration_ms: durationMs, finalUrl: currentUrl };
    }
    return {
      status: 'failure', http_code: status, duration_ms: durationMs,
      error: `HTTP_${status}`, finalUrl: currentUrl,
    };
  }
}
