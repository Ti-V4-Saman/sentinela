// Acesso a dados da integração por webhook em lote — TENANT-SAFE (Etapa B — integração em lote).
//
// Invariante de segurança: TODA função aqui recebe `tenantId` e filtra por ele em SQL (nunca
// confia em id cru sem o filtro de tenant). Cross-tenant/inexistente retorna `null`/`[]` — quem
// decide o `404` HTTP é a camada de rotas (Task 8).
//
// `loadWindowData` é a ÚNICA consulta que lê `messages`/`chats` (dados de captura) para montar o
// payload de exportação — é estritamente READ-ONLY (nunca escreve nessas tabelas) e o `WHERE
// tenant_id = ?` nela é o ponto ÚNICO de isolamento cross-tenant que `buildPayload` (Task 6)
// confia: o builder não revalida tenant, então um bug aqui vazaria dados de outro tenant.

import { decryptSecret } from './secret.js';
import { decodeSnapshot } from './payload-snapshot.js';

const TYPE = 'webhook_batch';

// Colunas de METADATA de integration_delivery_batches expostas em listagens/API — deliberadamente
// enumeradas (nunca `SELECT *`) para que `payload_compressed` (o corpo comprimido do payload) NUNCA
// vaze por um endpoint de listagem/detalhe/auditoria (ver plano, item 7). `payload_sha256`,
// `payload_size_bytes`, `payload_encoding`, `payload_created_at` e `target_url_snapshot` são
// metadata segura (não é o corpo) — inclusos para auditoria/UI. `content_options_snapshot` também é
// metadata (flags, não corpo). Se uma coluna nova for adicionada à tabela no futuro, ela só aparece
// aqui se alguém explicitamente decidir expô-la — nunca por acidente via SELECT *.
const BATCH_METADATA_COLUMNS = [
  'id', 'tenant_id', 'integration_id', 'schema_version', 'window_start', 'window_end',
  'part', 'part_total', 'idempotency_key', 'status', 'conversation_count', 'message_count',
  'attempt_count', 'next_attempt_at', 'last_attempt_at', 'created_at', 'updated_at',
  'payload_sha256', 'payload_size_bytes', 'payload_encoding', 'payload_created_at',
  'target_url_snapshot', 'content_options_snapshot',
].join(', ');

// ---- tenant_integrations ----

export async function getConfig(pool, tenantId) {
  const [rows] = await pool.query(
    'SELECT * FROM tenant_integrations WHERE tenant_id = ? AND type = ? LIMIT 1',
    [tenantId, TYPE],
  );
  return rows[0] || null;
}

// Remove secret_encrypted de uma linha de config antes de expor a chamadores que montam resposta
// de API — só secret_masked/secret_set_at (nunca o cifrado, nunca o plaintext).
export function publicConfig(row) {
  if (!row) return null;
  const { secret_encrypted, ...rest } = row;
  void secret_encrypted;
  return rest;
}

const UPSERT_PATCH_COLUMNS = [
  'active', 'target_url', 'frequency', 'run_at_time', 'timezone',
  'include_direct', 'include_groups', 'include_from_me', 'include_audio_transcripts',
];

// Insere ou atualiza a única linha (tenant_id, type='webhook_batch'). NÃO toca nas colunas de
// secret (secret_encrypted/secret_masked/secret_set_at) — isso é responsabilidade de `rotateSecret`.
export async function upsertConfig(pool, tenantId, patch, actorId) {
  const cols = ['tenant_id', 'type'];
  const placeholders = ['?', '?'];
  const values = [tenantId, TYPE];
  const updates = ['updated_by = VALUES(updated_by)'];

  for (const key of UPSERT_PATCH_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      cols.push(key);
      placeholders.push('?');
      values.push(patch[key]);
      updates.push(`${key} = VALUES(${key})`);
    }
  }
  cols.push('updated_by');
  placeholders.push('?');
  values.push(actorId);

  await pool.query(
    `INSERT INTO tenant_integrations (${cols.join(', ')}) VALUES (${placeholders.join(', ')})
     ON DUPLICATE KEY UPDATE ${updates.join(', ')}`,
    values,
  );
  return getConfig(pool, tenantId);
}

// Grava o resultado de uma (re)geração de secret: cifrado (reversível) + máscara + timestamp.
// Nunca recebe/grava o plaintext.
export async function rotateSecret(pool, tenantId, { encrypted, masked }) {
  await pool.query(
    `UPDATE tenant_integrations
       SET secret_encrypted = ?, secret_masked = ?, secret_set_at = NOW()
     WHERE tenant_id = ? AND type = ?`,
    [encrypted, masked, tenantId, TYPE],
  );
  return getConfig(pool, tenantId);
}

// Carrega o secret PLAINTEXT do tenant (decifrado em memória) para assinar uma entrega real —
// única função deste módulo que devolve o plaintext. Nunca loga/persiste o retorno; chamadores
// devem usá-lo só para assinar (signature.js) e descartar. Retorna null se a integração não
// existir ou não tiver secret configurado ainda.
export async function getSigningSecret(pool, tenantId, key) {
  const config = await getConfig(pool, tenantId);
  if (!config || !config.secret_encrypted) return null;
  return decryptSecret(config.secret_encrypted, key);
}

// Lista TODAS as integrações ativas (active=1) de TODOS os tenants — usada exclusivamente pelo
// job de despacho (Task 9), que precisa varrer o sistema inteiro para achar janelas vencidas.
// Diferente das demais funções deste módulo, NÃO filtra por um único tenantId (o próprio ponto
// desta função é cruzar tenants); cada linha retornada já traz `tenant_id`, então o chamador
// segue tenant-safe ao usar essa coluna em todas as chamadas subsequentes por integração.
export async function listActiveIntegrations(pool) {
  const [rows] = await pool.query(
    `SELECT * FROM tenant_integrations WHERE type = ? AND active = 1`,
    [TYPE],
  );
  return rows;
}

// Atualiza somente `last_run_window_end` (chamado pelo job de despacho após criar o(s) batch(es)
// de uma janela — marca a janela como processada para que a próxima execução não a repita,
// independentemente de a entrega ter sido tentada/bem-sucedida).
export async function updateLastRunWindowEnd(pool, tenantId, integrationId, windowEnd) {
  await pool.query(
    `UPDATE tenant_integrations SET last_run_window_end = ?
     WHERE tenant_id = ? AND id = ? AND type = ?`,
    [windowEnd, tenantId, integrationId, TYPE],
  );
}

// ---- integration_delivery_batches ----

// Lista batches para a API/UI — SÓ metadata (nunca `payload_compressed`, ver plano item 7 e
// BATCH_METADATA_COLUMNS acima). `SELECT` enumera as colunas explicitamente, não `SELECT *`.
export async function listBatches(pool, tenantId, { page = 1, limit = 20 } = {}) {
  const offset = (page - 1) * limit;
  const [countRows] = await pool.query(
    'SELECT COUNT(*) AS total FROM integration_delivery_batches WHERE tenant_id = ?',
    [tenantId],
  );
  const total = countRows[0].total;
  const [rows] = await pool.query(
    `SELECT ${BATCH_METADATA_COLUMNS} FROM integration_delivery_batches WHERE tenant_id = ?
     ORDER BY window_end DESC, part ASC
     LIMIT ? OFFSET ?`,
    [tenantId, limit, offset],
  );
  return { rows, total, page, limit };
}

// Detalhe de UM batch para a API/UI — mesma disciplina de `listBatches`: só metadata.
export async function getBatch(pool, tenantId, batchId) {
  const [rows] = await pool.query(
    `SELECT ${BATCH_METADATA_COLUMNS} FROM integration_delivery_batches WHERE tenant_id = ? AND id = ? LIMIT 1`,
    [tenantId, batchId],
  );
  return rows[0] || null;
}

export async function listAttempts(pool, tenantId, batchId) {
  const [rows] = await pool.query(
    `SELECT * FROM integration_delivery_attempts WHERE tenant_id = ? AND batch_id = ?
     ORDER BY attempt_no ASC`,
    [tenantId, batchId],
  );
  return rows;
}

// Cria um batch IDEMPOTENTE por idempotency_key (uq_batch_idem) E por uq_batch_window
// (tenant_id, integration_id, window_start, window_end, schema_version, part) — a tabela tem AS
// DUAS UNIQUE KEYs, e uma segunda chamada que colida em QUALQUER uma delas NUNCA cria uma segunda
// linha nem sobrescreve os dados da primeira — retorna o id da linha já existente.
//
// Por que checar as DUAS chaves antes do insert: se a checagem prévia olhasse só idempotency_key,
// uma chamada com uma idempotencyKey NOVA mas a MESMA janela (tenant_id, integration_id,
// window_start, window_end, schema_version, part) não seria detectada aqui — o INSERT então
// colidiria em uq_batch_window, `LAST_INSERT_ID(id)` devolveria o id da linha ORIGINAL, e a função
// reportaria `created: true` incorretamente enquanto o partTotal/messageCount da nova chamada
// seriam descartados silenciosamente (a linha original nunca é tocada pelo ON DUPLICATE KEY UPDATE
// id = LAST_INSERT_ID(id), que só reatribui o id, não as outras colunas). Checando as duas chaves
// aqui, detectamos a colisão de janela ANTES do insert e retornamos a linha existente sem perda.
//
// Implementação: SELECT-then-INSERT dentro de `INSERT ... ON DUPLICATE KEY UPDATE
// id = LAST_INSERT_ID(id)` para obter o id existente via `insertId` mesmo em conflito — mas como
// `affectedRows` desse padrão NÃO é um indicador confiável de "foi inserido agora" nesta
// configuração de servidor (observado: sempre 1, também quando colide), a decisão de "created"
// vem de uma leitura prévia da linha por idempotency_key OU pela tupla de janela, feita ANTES do
// insert, na mesma conexão/transação do chamador — suficiente para uso single-writer-per-key deste
// job. O INSERT ... ON DUPLICATE KEY UPDATE continua como cinto-e-suspensórios para a corrida rara
// (outra conexão insere entre o SELECT e o INSERT desta chamada).
// `initialStatus` (default 'pending') é usado SÓ no INSERT — o chamador (job) passa 'pending' com
// o gate ligado ou 'blocked' com o gate desligado (R4). Nunca faz downgrade de uma linha já
// existente: se a tupla de idempotência/janela já existe (colisão detectada pelo SELECT prévio),
// esta chamada retorna a linha existente tal como está, mesmo que `initialStatus` seja diferente do
// status atual dela.
//
// SNAPSHOT (Etapa B, S2 — ver docs/superpowers/plans/2026-07-28-etapaB-payload-snapshot.md, seção
// "Formato do snapshot" e regras 1/2): `payloadCompressed`/`payloadSha256`/`payloadSizeBytes`/
// `payloadEncoding`/`targetUrlSnapshot`/`contentOptionsSnapshot` são gravados NO MESMO INSERT que a
// metadata/idempotency_key/part/contagens — nunca existe um batch utilizável sem snapshot completo
// (regra 1). `payload_created_at = NOW()` marca o instante da persistência.
//
// DUPLICATE (regra 2): quando o SELECT prévio encontra uma linha já existente (por idempotency_key
// OU pela tupla de janela), o snapshot recém-calculado pelo CHAMADOR é DESCARTADO — o primeiro
// snapshot gravado é autoritativo e nunca é sobrescrito, mesmo que dados de origem tenham mudado
// entre execuções. Antes de devolver `created:false`, esta função recarrega o snapshot já
// persistido e chama `decodeSnapshot` sobre ELE MESMO (nunca compara com um sha recém-calculado) —
// isso confirma que o que está gravado no banco é internamente consistente (o corpo comprimido
// ainda hasheia para o sha persistido). Se `decodeSnapshot` lançar (adulteração/corrupção), o erro
// de integridade é propagado — esta função NUNCA retorna um batch "existente" usável nesse caso.
export async function createBatch(pool, {
  tenantId, integrationId, schemaVersion, windowStart, windowEnd, part = 1, partTotal = 1,
  idempotencyKey, conversationCount = 0, messageCount = 0, initialStatus = 'pending',
  payloadCompressed, payloadSha256, payloadSizeBytes, payloadEncoding,
  targetUrlSnapshot = null, contentOptionsSnapshot = null,
}) {
  const [existingRows] = await pool.query(
    `SELECT id, payload_compressed, payload_encoding, payload_sha256, payload_size_bytes
     FROM integration_delivery_batches
     WHERE idempotency_key = ?
        OR (tenant_id = ? AND integration_id = ? AND window_start = ? AND window_end = ?
            AND schema_version = ? AND part = ?)
     LIMIT 1`,
    [idempotencyKey, tenantId, integrationId, windowStart, windowEnd, schemaVersion, part],
  );
  if (existingRows[0]) {
    assertExistingSnapshotConsistent(existingRows[0]);
    return { id: existingRows[0].id, created: false };
  }

  if (payloadCompressed == null || !payloadSha256 || payloadSizeBytes == null || !payloadEncoding) {
    throw new Error('PAYLOAD_SNAPSHOT_REQUIRED');
  }

  const [result] = await pool.query(
    `INSERT INTO integration_delivery_batches
       (tenant_id, integration_id, schema_version, window_start, window_end, part, part_total,
        idempotency_key, status, conversation_count, message_count,
        payload_compressed, payload_sha256, payload_size_bytes, payload_encoding, payload_created_at,
        target_url_snapshot, content_options_snapshot)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?)
     ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
    [
      tenantId, integrationId, schemaVersion, windowStart, windowEnd, part, partTotal,
      idempotencyKey, initialStatus, conversationCount, messageCount,
      payloadCompressed, payloadSha256, payloadSizeBytes, payloadEncoding,
      targetUrlSnapshot, contentOptionsSnapshot == null ? null : JSON.stringify(contentOptionsSnapshot),
    ],
  );
  // Corrida rara (outra conexão inseriu entre o SELECT e o INSERT desta): o ON DUPLICATE KEY
  // UPDATE ainda garante que não haverá 2 linhas — LAST_INSERT_ID(id) devolve o id da linha
  // vencedora (a nossa, se ganhamos a corrida; a existente, se perdemos). Se perdemos a corrida, o
  // snapshot que "ganhou" é o da outra conexão — não revalidamos aqui (caminho raríssimo,
  // equivalente em espírito ao SELECT-then-INSERT de cima; auto-consistência já é garantida na
  // criação de quem venceu).
  return { id: result.insertId, created: true };
}

// Confere que o snapshot de uma linha JÁ EXISTENTE é internamente consistente — nunca compara com
// um sha recém-calculado pelo chamador (o snapshot original é autoritativo). Lança PAYLOAD_INTEGRITY
// se as colunas de snapshot estiverem ausentes (NULL — batch pré-existente sem snapshot, não
// entregável) ou se o corpo comprimido não hashear mais para o sha persistido (adulteração).
function assertExistingSnapshotConsistent(row) {
  if (row.payload_compressed == null || !row.payload_sha256 || row.payload_size_bytes == null || !row.payload_encoding) {
    throw new Error('PAYLOAD_INTEGRITY');
  }
  decodeSnapshot({
    compressed: row.payload_compressed,
    encoding: row.payload_encoding,
    sha256: row.payload_sha256,
    sizeBytes: row.payload_size_bytes,
  });
}

// Carrega o snapshot completo (corpo descomprimido + target_url_snapshot) de UM batch para
// entrega/retry/reenvio (S3, próxima tarefa) — a ÚNICA função deste módulo que devolve o corpo do
// payload em memória, carregado sob demanda por batch (nunca em listagem, mantém memória limitada).
// Lança PAYLOAD_INTEGRITY se o snapshot estiver ausente (colunas NULL — batch não-entregável) ou
// inconsistente (adulteração no banco).
export async function loadBatchSnapshot(pool, batchId) {
  const [rows] = await pool.query(
    `SELECT payload_compressed, payload_encoding, payload_sha256, payload_size_bytes, target_url_snapshot
     FROM integration_delivery_batches WHERE id = ? LIMIT 1`,
    [batchId],
  );
  const row = rows[0];
  if (!row || row.payload_compressed == null || !row.payload_sha256 || row.payload_size_bytes == null || !row.payload_encoding) {
    throw new Error('PAYLOAD_INTEGRITY');
  }
  const rawBody = decodeSnapshot({
    compressed: row.payload_compressed,
    encoding: row.payload_encoding,
    sha256: row.payload_sha256,
    sizeBytes: row.payload_size_bytes,
  });
  return {
    rawBody, targetUrl: row.target_url_snapshot, sha256: row.payload_sha256, sizeBytes: row.payload_size_bytes,
  };
}

// Grava uma tentativa de entrega. `error` já deve chegar SANITIZADO (sem secret/URL crua/corpo) —
// este módulo não sanitiza, apenas persiste.
export async function recordAttempt(pool, {
  tenantId, batchId, attemptNo, status, httpCode = null, durationMs = null, error = null,
}) {
  const [result] = await pool.query(
    `INSERT INTO integration_delivery_attempts
       (tenant_id, batch_id, attempt_no, status, http_code, duration_ms, error)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [tenantId, batchId, attemptNo, status, httpCode, durationMs, error],
  );
  return result.insertId;
}

export async function setBatchStatus(pool, tenantId, batchId, status) {
  await pool.query(
    'UPDATE integration_delivery_batches SET status = ? WHERE tenant_id = ? AND id = ?',
    [status, tenantId, batchId],
  );
}

// ---- máquina de estados de entrega/retry (R2/R3/R4) — primitivas persistidas ----
//
// `integration_delivery_batches.status` ∈ { pending, blocked, delivering, pending_retry, delivered,
// failed } (ver migrations/20260801140000_integration_retry_fields.cjs e o plano, seção "Máquina de
// estados de entrega/retry"). As funções abaixo são as primitivas de baixo nível que o JOB (próxima
// tarefa) orquestra em um ciclo de despacho; nenhuma delas decide sozinha a política de quando
// rodar — só executam a transição pedida de forma atômica/segura.
//
// Note: estas funções operam por `batchId` (não recebem tenantId como filtro adicional) porque o
// job já obtém o batchId a partir de consultas tenant-aware (listDueBatches inclui tenant_id na
// linha retornada) — mas nada aqui impede adicionar `AND tenant_id = ?` se um chamador futuro
// precisar reforçar o filtro; por ora seguem o padrão mínimo pedido no plano.

// Tenta reivindicar um batch para uma tentativa de entrega, atomicamente: só transiciona para
// `delivering` se o batch estiver num status elegível E (sem next_attempt_at OU já vencido). Esta é
// a GUARDA DE CONCORRÊNCIA central — um UPDATE condicional cujo `affectedRows` diz se ESTA chamada
// venceu a corrida (1) ou se outra já tinha pego o batch primeiro (0). Um segundo
// worker/reenvio-manual concorrente na mesma linha sempre recebe `claimed:false` (WHERE já não
// casa mais depois que o primeiro mudou o status).
//
// `includeBlocked` (default false): batches `blocked` só entram no WHERE IN(...) quando o chamador
// sinaliza explicitamente que o gate está ON (R4 — batches blocked não devem ser reivindicados por
// engano enquanto o gate segue desligado).
export async function claimBatchForAttempt(pool, batchId, { now, includeBlocked = false }) {
  const statuses = includeBlocked
    ? ['pending', 'pending_retry', 'blocked']
    : ['pending', 'pending_retry'];
  const placeholders = statuses.map(() => '?').join(', ');

  const [result] = await pool.query(
    `UPDATE integration_delivery_batches
       SET status = 'delivering', last_attempt_at = ?, updated_at = NOW()
     WHERE id = ? AND status IN (${placeholders}) AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
    [now, batchId, ...statuses, now],
  );
  return { claimed: result.affectedRows === 1 };
}

// Lista os batches elegíveis para uma tentativa NESTE ciclo do job — usada pelo job para saber por
// quais batches iterar (não reivindica nada sozinha; o job ainda chama claimBatchForAttempt por
// batch antes de tentar, para a guarda de concorrência valer mesmo com múltiplos workers).
//
// Elegibilidade: status IN ('pending','pending_retry') sempre; mais 'blocked' quando `gateOn` (R4 —
// batches criados com o gate desligado só voltam a ser candidatos quando o gate liga). Em ambos os
// casos, respeita `next_attempt_at IS NULL OR next_attempt_at <= now`.
//
// `maxCatchupDays` (opcional): quando informado, EXCLUI batches `blocked` cujo `window_end` seja
// mais antigo que `now - maxCatchupDays` dias — protege contra uma rajada de entregas antigas ao
// ligar o gate depois de muito tempo desligado (retenção de catchup, R4). Só se aplica a 'blocked';
// 'pending'/'pending_retry' nunca são excluídos por idade (são o fluxo normal, não histórico
// represado). Batches blocked mais antigos que o catchup permanecem 'blocked' (histórico) — NÃO são
// marcados 'failed' por retenção.
export async function listDueBatches(pool, { now, gateOn, limit = 100, maxCatchupDays = null }) {
  const statuses = gateOn ? ['pending', 'pending_retry', 'blocked'] : ['pending', 'pending_retry'];
  const placeholders = statuses.map(() => '?').join(', ');

  const conditions = [
    `status IN (${placeholders})`,
    '(next_attempt_at IS NULL OR next_attempt_at <= ?)',
  ];
  const args = [...statuses, now];

  if (gateOn && maxCatchupDays != null) {
    // blocked antigo demais: excluído. pending/pending_retry: nunca excluídos por esta cláusula
    // (a condição só restringe quando status = 'blocked').
    conditions.push("(status <> 'blocked' OR window_end >= DATE_SUB(?, INTERVAL ? DAY))");
    args.push(now, maxCatchupDays);
  }

  const [rows] = await pool.query(
    `SELECT id, tenant_id, integration_id, window_start, window_end, part, part_total,
            schema_version, status, attempt_count, next_attempt_at, last_attempt_at, idempotency_key
     FROM integration_delivery_batches
     WHERE ${conditions.join(' AND ')}
     ORDER BY next_attempt_at IS NULL DESC, next_attempt_at ASC, created_at ASC
     LIMIT ?`,
    [...args, limit],
  );
  return rows;
}

// Agenda o retry após uma tentativa FALHA. `attemptCount` é o número de tentativas já feitas até
// agora (1-based; inclui a que acabou de falhar). Se esgotou `maxAttempts` → status `failed`
// (terminal), `next_attempt_at = NULL`. Senão → `pending_retry`, `attempt_count` gravado, e
// `next_attempt_at = now + backoffMinutes[attemptCount-1]` minutos (índice 0-based: depois da 1ª
// falha usa backoffMinutes[0]=2min, depois da 2ª usa backoffMinutes[1]=6min, etc — ver
// deliveryConfig().backoffMinutes em config.js). Calculado em JS/UTC e armazenado como DATETIME.
export async function scheduleRetry(pool, batchId, {
  attemptCount, now, backoffMinutes, maxAttempts,
}) {
  if (attemptCount >= maxAttempts) {
    await pool.query(
      `UPDATE integration_delivery_batches
         SET status = 'failed', attempt_count = ?, next_attempt_at = NULL, updated_at = NOW()
       WHERE id = ?`,
      [attemptCount, batchId],
    );
    return { status: 'failed', next_attempt_at: null };
  }

  const delayMinutes = backoffMinutes[attemptCount - 1];
  const nextAttemptAt = new Date(now.getTime() + delayMinutes * 60_000);

  await pool.query(
    `UPDATE integration_delivery_batches
       SET status = 'pending_retry', attempt_count = ?, next_attempt_at = ?, updated_at = NOW()
     WHERE id = ?`,
    [attemptCount, nextAttemptAt, batchId],
  );
  return { status: 'pending_retry', next_attempt_at: nextAttemptAt };
}

// Marca sucesso definitivo (terminal) — cancela qualquer retry pendente. Idempotente: o WHERE
// `status <> 'delivered'` faz uma segunda chamada virar no-op silencioso em vez de erro.
export async function markDelivered(pool, batchId, { now }) {
  await pool.query(
    `UPDATE integration_delivery_batches
       SET status = 'delivered', next_attempt_at = NULL, updated_at = ?
     WHERE id = ? AND status <> 'delivered'`,
    [now, batchId],
  );
}

// Marca o batch como `blocked` — usado quando (a) um batch é criado com o gate OFF (ver
// `createBatch(..., { initialStatus: 'blocked' })`), ou (b) uma tentativa em `delivering` descobre
// que o gate foi desligado no meio do caminho e precisa recuar sem contar como falha.
export async function markBlocked(pool, batchId) {
  await pool.query(
    `UPDATE integration_delivery_batches SET status = 'blocked', updated_at = NOW() WHERE id = ?`,
    [batchId],
  );
}

// Desfaz uma reivindicação (`delivering`) sem registrar uma tentativa/falha — usado quando o job
// reivindicou o batch mas não conseguiu prosseguir por um motivo que não é uma falha de entrega
// real (ex.: gate caiu entre o claim e o envio). Volta para `toStatus` (tipicamente o status
// anterior ao claim: 'pending', 'pending_retry' ou 'blocked') sem tocar em attempt_count/
// next_attempt_at — a tentativa não aconteceu, então nada do estado de retry deve avançar.
export async function releaseClaim(pool, batchId, { toStatus }) {
  await pool.query(
    `UPDATE integration_delivery_batches SET status = ?, updated_at = NOW() WHERE id = ?`,
    [toStatus, batchId],
  );
}

// ---- leitura read-only de conversas/mensagens para montar o payload ----

// Lê (SEM ESCREVER NADA) as conversas e mensagens do tenant dentro de [window.start, window.end),
// respeitando os filtros de conteúdo da integração (include_direct/include_groups/include_from_me
// /include_audio_transcripts). Mapeia as colunas do banco para a forma que `buildPayload` (Task 6)
// espera: { chat_id, external_id, from_me, type, timestamp, text, transcript, is_group }.
//
// `messages` não tem coluna de transcript separada — a transcrição de áudio é o próprio
// `messages.text` quando `type = 'audio'` (documentado em docs/DESIGN-SYSTEM.md). Por isso:
// - se a integração NÃO autoriza áudio (`include_audio_transcripts = false`), mensagens de áudio
//   são excluídas inteiramente da leitura (não haveria texto/transcript válido para expor);
// - se autoriza, `text` de uma mensagem de áudio é devolvido também como `transcript` (e omitido
//   de `text`), para casar com a allow-list do builder (que só emite `transcript` quando
//   `type === 'audio' && integration.include_audio_transcripts === true`).
export async function loadWindowData(pool, tenantId, integration, window) {
  const where = ['m.tenant_id = ?', 'm.timestamp >= ?', 'm.timestamp < ?'];
  const args = [tenantId, window.start, window.end];

  const groupClauses = [];
  if (integration.include_direct) groupClauses.push('c.is_group = 0');
  if (integration.include_groups) groupClauses.push('c.is_group = 1');
  if (groupClauses.length === 0) {
    // Nenhum tipo de conversa autorizado: nenhuma mensagem pode ser incluída.
    return { conversations: [], messages: [] };
  }
  where.push(`(${groupClauses.join(' OR ')})`);

  if (!integration.include_from_me) {
    where.push('m.from_me = 0');
  }

  if (!integration.include_audio_transcripts) {
    where.push("m.type <> 'audio'");
  }

  const [rows] = await pool.query(
    `SELECT m.chat_id, m.id AS external_id, m.from_me, m.type, m.timestamp, m.text,
            c.is_group
     FROM messages m
     JOIN chats c ON c.tenant_id = m.tenant_id AND c.id = m.chat_id
     WHERE ${where.join(' AND ')}
     ORDER BY m.timestamp ASC, m.id ASC`,
    args,
  );

  const messages = rows.map((r) => {
    const isAudio = r.type === 'audio';
    return {
      chat_id: r.chat_id,
      external_id: r.external_id,
      from_me: Number(r.from_me) === 1,
      type: r.type,
      timestamp: r.timestamp,
      text: isAudio ? null : r.text,
      transcript: isAudio ? r.text : null,
    };
  });

  const seen = new Map();
  for (const r of rows) {
    if (!seen.has(r.chat_id)) {
      seen.set(r.chat_id, { chat_id: r.chat_id, is_group: Number(r.is_group) === 1 });
    }
  }
  const conversations = [...seen.values()];

  return { conversations, messages };
}
