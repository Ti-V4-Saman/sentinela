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
