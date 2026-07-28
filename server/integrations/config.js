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
//
// backoffMinutes: atraso (em minutos) antes de CADA tentativa após uma falha — índice 0 é o atraso
// aplicado depois da 1ª falha (attempt_count=1), índice 1 depois da 2ª falha, etc. A 1ª tentativa em
// si é sempre imediata (next_attempt_at NULL na criação do batch). maxAttempts=5 → no máximo 4
// retries agendados (backoffMinutes tem 4 posições); esgotado o array/maxAttempts, o batch vai para
// `failed`. Ver docs/superpowers/plans/2026-07-28-etapaB-hardening.md, seção "Máquina de estados de
// entrega/retry (R2/R3/R4)".
export function deliveryConfig() {
  return {
    timeoutMs: 15000,
    maxAttempts: 5,
    maxRedirects: 3,
    chunkMaxMessages: 5000,
    chunkMaxBytes: 5_000_000,
    successMin: 200,
    successMax: 299,
    backoffMinutes: [2, 6, 18, 54],
  };
}

// Retenção de catchup para batches `blocked` (gate OFF) — quantos dias no passado o job ainda
// entrega automaticamente quando o gate liga. Batches `blocked` mais antigos que N dias NÃO são
// entregues automaticamente (ficam como histórico/`blocked` — nunca forçados a `failed` só por
// retenção; ver plano, seção "Gate off + avanço de janela + catchup (R4)"). Lazy (lê env a cada
// chamada, nunca cacheia), igual às demais funções deste módulo. Default 7; valida inteiro positivo.
export function integrationsMaxCatchupDays() {
  const raw = process.env.INTEGRATIONS_MAX_CATCHUP_DAYS;
  if (raw === undefined || raw === '') return 7;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error('INTEGRATIONS_MAX_CATCHUP_DAYS inválido — deve ser um inteiro positivo (dias)');
  }
  return n;
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

// Mapeia QUALQUER exceção para um código curto e fechado — nunca expõe `e.message` (poderia
// embutir URL/secret/detalhe de conexão). Reconhece algumas classes comuns pelo `code`/`name` do
// erro nativo do Node/mysql2; tudo que não bate um padrão conhecido cai em UNKNOWN.
//
// Compartilhado entre o job (server/jobs/dispatch-integrations.js) e as rotas
// (server/routes/integrations.js) — ver docs/superpowers/plans/2026-07-28-etapaB-hardening.md,
// seção "Logs sanitizados (R4)". NUNCA alterar esta função para incluir `e.message`/`e.stack` no
// retorno; os dois chamadores dependem de um mapeamento fechado idêntico.
export function sanitizeError(e) {
  if (!e) return 'UNKNOWN';
  const code = e.code || '';
  const name = e.name || '';

  if (
    code.startsWith('ER_') || code === 'ECONNREFUSED' || code === 'PROTOCOL_CONNECTION_LOST'
    || code === 'ETIMEDOUT' || name === 'SqlError'
  ) {
    return 'DB_ERROR';
  }
  if (name === 'AbortError' || code === 'ABORT_ERR') return 'TIMEOUT';
  if (code === 'ENOTFOUND' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return 'NETWORK';
  }
  if (name === 'TypeError' && /URL/i.test(String(e.message || ''))) return 'URL_ERROR';
  if (name === 'ERR_INVALID_URL' || code === 'ERR_INVALID_URL') return 'URL_ERROR';
  if (/CRYPTO|cipher|decrypt/i.test(name) || /cipher|decrypt|auth tag/i.test(String(e.message || ''))) {
    return 'CRYPTO_ERROR';
  }
  if (/config|env|inválid/i.test(String(e.message || '')) && !code) return 'CONFIG_ERROR';
  return 'UNKNOWN';
}
