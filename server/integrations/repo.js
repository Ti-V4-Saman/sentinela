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

const TYPE = 'webhook_batch';

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

export async function listBatches(pool, tenantId, { page = 1, limit = 20 } = {}) {
  const offset = (page - 1) * limit;
  const [countRows] = await pool.query(
    'SELECT COUNT(*) AS total FROM integration_delivery_batches WHERE tenant_id = ?',
    [tenantId],
  );
  const total = countRows[0].total;
  const [rows] = await pool.query(
    `SELECT * FROM integration_delivery_batches WHERE tenant_id = ?
     ORDER BY window_end DESC, part ASC
     LIMIT ? OFFSET ?`,
    [tenantId, limit, offset],
  );
  return { rows, total, page, limit };
}

export async function getBatch(pool, tenantId, batchId) {
  const [rows] = await pool.query(
    'SELECT * FROM integration_delivery_batches WHERE tenant_id = ? AND id = ? LIMIT 1',
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
export async function createBatch(pool, {
  tenantId, integrationId, schemaVersion, windowStart, windowEnd, part = 1, partTotal = 1,
  idempotencyKey, conversationCount = 0, messageCount = 0,
}) {
  const [existingRows] = await pool.query(
    `SELECT id FROM integration_delivery_batches
     WHERE idempotency_key = ?
        OR (tenant_id = ? AND integration_id = ? AND window_start = ? AND window_end = ?
            AND schema_version = ? AND part = ?)
     LIMIT 1`,
    [idempotencyKey, tenantId, integrationId, windowStart, windowEnd, schemaVersion, part],
  );
  if (existingRows[0]) {
    return { id: existingRows[0].id, created: false };
  }

  const [result] = await pool.query(
    `INSERT INTO integration_delivery_batches
       (tenant_id, integration_id, schema_version, window_start, window_end, part, part_total,
        idempotency_key, status, conversation_count, message_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
     ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
    [
      tenantId, integrationId, schemaVersion, windowStart, windowEnd, part, partTotal,
      idempotencyKey, conversationCount, messageCount,
    ],
  );
  // Corrida rara (outra conexão inseriu entre o SELECT e o INSERT desta): o ON DUPLICATE KEY
  // UPDATE ainda garante que não haverá 2 linhas — LAST_INSERT_ID(id) devolve o id da linha
  // vencedora (a nossa, se ganhamos a corrida; a existente, se perdemos).
  return { id: result.insertId, created: true };
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
