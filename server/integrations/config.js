// Flags/constantes de ambiente da integração por webhook em lote (Etapa B).
//
// Módulo de LEITURA de ambiente: lê `process.env` a cada chamada (nunca cacheia em import-time),
// para que os testes possam ligar/desligar `EXTERNAL_INTEGRATIONS_ENABLED`/`NODE_ENV` entre casos
// via `process.env.X = ...` sem precisar reimportar o módulo.

// Default `false`. Só é `true` com a string EXATA 'true' — qualquer outro valor (undefined, '',
// '1', 'TRUE', etc.) é tratado como desligado (fail-closed).
export function externalIntegrationsEnabled() {
  return process.env.EXTERNAL_INTEGRATIONS_ENABLED === 'true';
}

// Constantes compartilhadas de entrega (verbatim do plano — seção "Constantes compartilhadas").
export function deliveryConfig() {
  return {
    timeoutMs: 15000,
    maxAttempts: 5,
    maxRedirects: 3,
    chunkMaxMessages: 5000,
    chunkMaxBytes: 5_000_000,
    successMin: 200,
    successMax: 299,
  };
}

// true em qualquer ambiente exceto teste — usado para decidir `allowHttp` na defesa SSRF
// (prod-like → allowHttp:false, só HTTPS).
export function isProdLike() {
  return process.env.NODE_ENV !== 'test';
}

// Chave de cifragem (AES-256-GCM) do secret HMAC em repouso — 32 bytes, lida de
// `INTEGRATIONS_SECRET_KEY` (aceita 64 chars hex OU base64). Lazy: só é lida/validada quando
// chamada (nunca em import-time), para não quebrar módulos que importam este arquivo sem
// precisarem assinar/decifrar nada. Lança erro claro se ausente ou de tamanho incorreto.
export function integrationsSecretKey() {
  const raw = process.env.INTEGRATIONS_SECRET_KEY;
  if (!raw) {
    throw new Error('INTEGRATIONS_SECRET_KEY ausente — defina uma chave de 32 bytes (64 hex ou base64) no .env');
  }
  let key;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    key = Buffer.from(raw, 'base64');
  }
  if (key.length !== 32) {
    throw new Error('INTEGRATIONS_SECRET_KEY inválida — deve decodificar para exatamente 32 bytes (64 hex ou base64)');
  }
  return key;
}
