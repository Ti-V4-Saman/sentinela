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
