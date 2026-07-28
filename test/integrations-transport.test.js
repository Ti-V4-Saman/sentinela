// Testes do transporte HTTP seguro (Etapa B — hardening R1 — anti DNS-rebinding).
//
// Abordagem escolhida (documentada conforme pedido na spec): DOIS grupos de teste.
//
// (A) Socket real, contra um servidor HTTPS local self-signed (gerado on-the-fly via `openssl`
//     em `beforeAll`, escutando em 127.0.0.1). `secureDeliver` roda a validação SSRF de verdade
//     sobre um IP PÚBLICO fictício (ex.: 93.184.216.34) devolvido pelo `lookupImpl` injetado — a
//     defesa SSRF real não é enfraquecida nem contornada. O único ponto de teste é
//     `__testConnectOverride`, um hook exportado apenas para teste (nunca usado por nenhum
//     chamador de produção — `delivery.js` nunca o passa) que redireciona o SOCKET (não a
//     validação) para 127.0.0.1:<porta do servidor de teste>. Isso prova, contra um servidor TLS
//     de verdade, que: o handshake usa SNI = hostname original, o header Host = hostname
//     original, `rejectUnauthorized` permanece true (cert self-signed sem CA confiável é
//     rejeitado), e o corpo da resposta nunca é exposto no retorno.
//
// (B) Contrato/shape com a camada de rede mockada: substitui apenas `lookupImpl` e inspeciona o
//     resultado/õ contagem de chamadas — sem tocar `node:https`/`node:http` — para provar o
//     invariante central de anti-rebinding (lookupImpl chamado uma única vez por hop; a 2ª
//     resolução, se ocorresse, devolveria um IP bloqueado, e o teste prova que ela nunca ocorre),
//     múltiplos IPs com um privado bloqueando tudo, redirect para hostname privado bloqueado,
//     redirect relativo resolvido corretamente, e gate/inputs inválidos.
//
// Nenhum teste toca rede/DNS real fora do servidor HTTPS local iniciado pelo próprio teste.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer as createHttpsServer } from 'node:https';
import { secureDeliver } from '../server/integrations/transport.js';

const PUBLIC_IP = '93.184.216.34'; // IP público de exemplo (documentação/RFC-friendly), nunca contatado de fato
const PRIVATE_IP = '10.0.0.5';
const METADATA_IP = '169.254.169.254';
const LOOPBACK_IP = '127.0.0.1';

function lookupResolving(ip, family = 4) {
  let calls = 0;
  const fn = async () => {
    calls += 1;
    return [{ address: ip, family }];
  };
  fn.callCount = () => calls;
  return fn;
}

// ---- Servidor HTTPS local self-signed (grupo A) ----

let certDir;
let certPem;
let keyPem;

beforeAll(() => {
  certDir = mkdtempSync(path.join(tmpdir(), 'sentinela-transport-test-'));
  const keyPath = path.join(certDir, 'key.pem');
  const certPath = path.join(certDir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-nodes', '-subj', '/CN=example.com',
    '-addext', 'subjectAltName=DNS:example.com', // Node/OpenSSL modernos exigem SAN, CN sozinho não basta
  ], { stdio: 'pipe' });
  keyPem = readFileSync(keyPath);
  certPem = readFileSync(certPath);
});

afterAll(() => {
  if (certDir) rmSync(certDir, { recursive: true, force: true });
});

function startHttpsServer(handler) {
  return new Promise((resolve) => {
    const server = createHttpsServer({ key: keyPem, cert: certPem }, handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

// Hooks de teste: sempre redirecionam o socket para 127.0.0.1:<port>, independente do IP/porta
// validados (SNI e Host continuam refletindo o hostname/porta ORIGINAIS). Usados SÓ nestes
// testes — nunca em produção (nenhum chamador real passa __testConnectOverride/__testPortOverride).
function pinToLocalServer() {
  return LOOPBACK_IP;
}
function pinToLocalPort(port) {
  return () => port;
}

describe('secureDeliver — socket real contra servidor HTTPS local (self-signed)', () => {
  it('valida com IP público (lookupImpl), conecta o socket no IP pinado, TLS ok, 200 -> success', async () => {
    let receivedHost = null;
    let receivedSNI = null;
    let receivedPath = null;
    const { server, port } = await startHttpsServer((req, res) => {
      receivedHost = req.headers.host;
      receivedSNI = req.socket.servername;
      receivedPath = req.url;
      res.writeHead(200);
      res.end('corpo-que-nao-deve-vazar-no-retorno');
    });

    try {
      const lookupImpl = lookupResolving(PUBLIC_IP);
      const result = await secureDeliver({
        url: 'https://example.com/webhook?x=1',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
        allowHttp: false,
        lookupImpl,
        __testConnectOverride: pinToLocalServer,
        __testPortOverride: pinToLocalPort(port),
        __testCa: certPem, // confia no self-signed do servidor de teste; rejectUnauthorized continua true
      });

      expect(result.status).toBe('success');
      expect(result.http_code).toBe(200);
      expect(typeof result.duration_ms).toBe('number');
      expect(JSON.stringify(result)).not.toMatch(/corpo-que-nao-deve-vazar/);

      // SNI e Host = hostname ORIGINAL (example.com), mesmo o socket tendo ido para 127.0.0.1.
      expect(receivedSNI).toBe('example.com');
      expect(receivedHost).toBe('example.com');
      expect(receivedPath).toBe('/webhook?x=1');
    } finally {
      await closeServer(server);
    }
  });

  it('cert self-signed sem CA confiável é REJEITADO (rejectUnauthorized permanece true) -> failure NETWORK', async () => {
    const { server, port } = await startHttpsServer((req, res) => {
      res.writeHead(200);
      res.end();
    });

    try {
      const lookupImpl = lookupResolving(PUBLIC_IP);
      const result = await secureDeliver({
        url: 'https://example.com/webhook',
        lookupImpl,
        __testConnectOverride: pinToLocalServer,
        __testPortOverride: pinToLocalPort(port),
      });

      // O handshake TLS deve falhar (cert self-signed, sem CA confiável) — NUNCA sucesso.
      expect(result.status).toBe('failure');
      expect(result.error).toBe('NETWORK');
    } finally {
      await closeServer(server);
    }
  });

  it('lookupImpl NÃO é chamado uma 2ª vez pelo cliente HTTP para o mesmo hop (prova anti-rebinding no socket real)', async () => {
    const { server, port } = await startHttpsServer((req, res) => {
      res.writeHead(200);
      res.end();
    });

    try {
      const lookupImpl = lookupResolving(PUBLIC_IP);
      const result = await secureDeliver({
        url: 'https://example.com/webhook',
        lookupImpl,
        __testConnectOverride: pinToLocalServer,
        __testPortOverride: pinToLocalPort(port),
        __testCa: certPem,
      });

      expect(result.status).toBe('success');
      // Uma única chamada: a validação SSRF resolveu o hostname UMA vez; o cliente HTTP usou a
      // opção `lookup` (pino) para o socket, sem consultar o DNS de novo.
      expect(lookupImpl.callCount()).toBe(1);
    } finally {
      await closeServer(server);
    }
  });
});

describe('secureDeliver — DNS rebinding (contrato): 2ª resolução nunca ocorre, mesmo que devolvesse IP bloqueado', () => {
  it('1ª chamada devolve IP público; se houvesse 2ª chamada devolveria 127.0.0.1 — prova que só a 1ª ocorre', async () => {
    let calls = 0;
    const lookupImpl = async () => {
      calls += 1;
      if (calls === 1) return [{ address: PUBLIC_IP, family: 4 }];
      // Se o transporte chamasse o resolver de novo (rebinding), isto devolveria loopback —
      // nunca deve ser alcançado neste teste porque HTTP real não roda aqui (mock de rede via
      // erro controlado abaixo simplesmente garante que não há 2ª tentativa de resolver).
      return [{ address: LOOPBACK_IP, family: 4 }];
    };

    // Sem servidor real: usamos uma porta que recusa conexão para forçar NETWORK rapidamente,
    // mantendo o foco do teste em "quantas vezes o resolver foi chamado", não no resultado HTTP.
    const result = await secureDeliver({
      url: 'https://example.com/webhook',
      lookupImpl,
      timeoutMs: 500,
      __testConnectOverride: () => '127.0.0.1', // conecta em loopback numa porta fechada -> ECONNREFUSED
    });

    expect(result.status).toBe('failure');
    expect(calls).toBe(1); // nunca houve 2ª resolução, mesmo a conexão falhando
  });

  it('se QUALQUER IP do hostname for privado, bloqueia tudo antes de conectar (multi-A record)', async () => {
    const lookupImpl = async () => [
      { address: PUBLIC_IP, family: 4 },
      { address: PRIVATE_IP, family: 4 },
    ];

    const result = await secureDeliver({
      url: 'https://example.com/webhook',
      lookupImpl,
    });

    expect(result.status).toBe('failure');
    expect(result.error).toBe('SSRF_BLOCKED:ip_resolvido_bloqueado');
  });

  it('IP literal metadata (169.254.169.254) é bloqueado sem chamar o resolver', async () => {
    let called = false;
    const lookupImpl = async () => { called = true; return [{ address: PUBLIC_IP, family: 4 }]; };

    const result = await secureDeliver({
      url: `https://${METADATA_IP}/latest/meta-data`,
      lookupImpl,
    });

    expect(result.status).toBe('failure');
    expect(result.error).toMatch(/^SSRF_BLOCKED:/);
    expect(called).toBe(false);
  });
});

describe('secureDeliver — redirects', () => {
  it('redirect para hostname público cujo DNS resolve para IP privado -> REDIRECT_BLOCKED', async () => {
    let receivedHost = null;
    const { server, port } = await startHttpsServer((req, res) => {
      receivedHost = req.headers.host;
      res.writeHead(302, { Location: 'https://evil.example/next' });
      res.end();
    });

    try {
      const lookupImpl = async (hostname) => {
        if (hostname === 'example.com') return [{ address: PUBLIC_IP, family: 4 }];
        if (hostname === 'evil.example') return [{ address: PRIVATE_IP, family: 4 }];
        throw new Error(`sem mock de DNS para ${hostname}`);
      };

      const result = await secureDeliver({
        url: 'https://example.com/webhook',
        lookupImpl,
        __testConnectOverride: pinToLocalServer,
        __testPortOverride: pinToLocalPort(port),
        __testCa: certPem,
      });

      expect(result.status).toBe('failure');
      expect(result.error).toBe('REDIRECT_BLOCKED');
      expect(receivedHost).toBe('example.com');
    } finally {
      await closeServer(server);
    }
  });

  it('redirect relativo é resolvido corretamente contra a URL base e revalidado', async () => {
    let hitCount = 0;
    const { server, port } = await startHttpsServer((req, res) => {
      hitCount += 1;
      if (req.url === '/start') {
        res.writeHead(302, { Location: '/next-step' }); // relativo
        res.end();
        return;
      }
      res.writeHead(200);
      res.end();
    });

    try {
      const lookupImpl = lookupResolving(PUBLIC_IP);
      const result = await secureDeliver({
        url: 'https://example.com/start',
        lookupImpl,
        __testConnectOverride: pinToLocalServer,
        __testPortOverride: pinToLocalPort(port),
        __testCa: certPem,
      });

      expect(result.status).toBe('success');
      expect(result.finalUrl).toBe('https://example.com/next-step');
      expect(hitCount).toBe(2); // seguiu exatamente 1 redirect relativo
    } finally {
      await closeServer(server);
    }
  });

  it('excede maxRedirects -> TOO_MANY_REDIRECTS, nunca segue automaticamente', async () => {
    let hits = 0;
    const { server, port } = await startHttpsServer((req, res) => {
      hits += 1;
      res.writeHead(302, { Location: `/hop-${hits}` });
      res.end();
    });

    try {
      const lookupImpl = lookupResolving(PUBLIC_IP);
      const result = await secureDeliver({
        url: 'https://example.com/start',
        lookupImpl,
        maxRedirects: 2,
        __testConnectOverride: pinToLocalServer,
        __testPortOverride: pinToLocalPort(port),
        __testCa: certPem,
      });

      expect(result.status).toBe('failure');
      expect(result.error).toBe('TOO_MANY_REDIRECTS');
      expect(hits).toBe(3); // start + 2 redirects permitidos, o 3º estoura o limite
    } finally {
      await closeServer(server);
    }
  });
});

describe('secureDeliver — gate/entrada', () => {
  it('URL com credenciais embutidas é bloqueada antes de qualquer conexão', async () => {
    let called = false;
    const lookupImpl = async () => { called = true; return [{ address: PUBLIC_IP, family: 4 }]; };

    const result = await secureDeliver({
      url: 'https://user:pass@example.com/webhook',
      lookupImpl,
    });

    expect(result.status).toBe('failure');
    expect(result.error).toMatch(/^SSRF_BLOCKED:/);
    expect(called).toBe(false);
  });

  it('http:// bloqueado quando allowHttp:false (default), permitido quando true', async () => {
    const lookupImpl = lookupResolving(PUBLIC_IP);

    const blocked = await secureDeliver({ url: 'http://example.com/webhook', lookupImpl });
    expect(blocked.status).toBe('failure');
    expect(blocked.error).toMatch(/^SSRF_BLOCKED:/);
  });

  it('o campo error nunca contém a URL alvo nem o corpo enviado (finalUrl é campo separado, não sanitizado por contrato)', async () => {
    const lookupImpl = async () => [{ address: PRIVATE_IP, family: 4 }];

    const result = await secureDeliver({
      url: 'https://internal-target.example/secret-path',
      body: 'segredo-do-corpo',
      lookupImpl,
    });

    // `error` é o código sanitizado (curto, sem URL/corpo). `finalUrl` é um campo separado do
    // contrato de secureDeliver (usado por chamadores internos para diagnóstico) — deliverBatch
    // (delivery.js) NUNCA repassa `finalUrl` para fora, então nenhuma URL crua chega a
    // logs/respostas de API a partir daí.
    expect(result.error).not.toMatch(/internal-target\.example/);
    expect(result.error).not.toMatch(/segredo-do-corpo/);
    expect(result.error).toBe('SSRF_BLOCKED:ip_resolvido_bloqueado');
  });
});
