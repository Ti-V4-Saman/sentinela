// Montagem do payload de exportação (allow-list de campos) + chunking determinístico
// (Etapa B — integração em lote).
//
// Módulo PURO: recebe arrays já lidos do banco em memória (a query real vive em `repo.js`,
// Task 7/8). Sem DB, sem rede, sem `Date.now()`/`new Date()` implícito — todo instante chega
// via parâmetro (`window.start`/`window.end` já são `Date`).
//
// Allow-list estrita: o objeto de saída é construído campo a campo (nunca por spread/cópia da
// linha fonte), então qualquer coluna nova adicionada no futuro à query de origem (ex.: notas
// internas, tokens, ids de outro tenant) NUNCA vaza automaticamente — precisa ser adicionada aqui
// explicitamente. Deny-list (nunca emitir): capture_wid, secret, secret_encrypted, token, password,
// password_hash, notas internas, dados de auditoria, payloads de auth, ids internos além dos
// listados, campos de outro tenant.

export const CHUNK_MAX_MESSAGES = 5000;
export const CHUNK_MAX_BYTES = 5_000_000; // 5 MB por parte (payload serializado)

// Monta o payload completo (não-chunked; part/part_total default 1) a partir de arrays em
// memória de conversas/mensagens já filtrados pelo chamador (tenant, include_*, janela).
export function buildPayload({ tenant, integration, window, conversations, messages, schemaVersion }) {
  const conversationsOut = conversations.map(buildConversation);
  const messagesOut = messages.map((m) => buildMessage(m, integration));

  return {
    schema_version: schemaVersion,
    batch: {
      tenant_id: tenant.id,
      window_start: window.start.toISOString(),
      window_end: window.end.toISOString(),
      part: 1,
      part_total: 1,
    },
    conversations: conversationsOut,
    messages: messagesOut,
  };
}

function buildConversation(row) {
  const out = {
    chat_id: row.chat_id,
    is_group: !!row.is_group,
  };
  if (row.contact_ref != null) {
    out.contact_ref = row.contact_ref;
  }
  return out;
}

function buildMessage(row, integration) {
  const out = {
    chat_id: row.chat_id,
    external_id: row.external_id,
    direction: row.from_me ? 'out' : 'in',
    type: row.type,
    timestamp: row.timestamp,
  };

  // `text`: incluído quando presente na origem (mantém simples, conforme spec da Task 6).
  if (row.text != null) {
    out.text = row.text;
  }

  // `transcript`: só quando a integração autoriza E a linha é de áudio E há transcript.
  if (integration.include_audio_transcripts === true && row.type === 'audio' && row.transcript != null) {
    out.transcript = row.transcript;
  }

  return out;
}

// Ordena mensagens deterministicamente por (timestamp, external_id) — garante que a mesma
// entrada sempre produza a mesma divisão em partes.
function sortMessagesDeterministically(messages) {
  return [...messages].sort((a, b) => {
    if (a.timestamp < b.timestamp) return -1;
    if (a.timestamp > b.timestamp) return 1;
    if (a.external_id < b.external_id) return -1;
    if (a.external_id > b.external_id) return 1;
    return 0;
  });
}

// Divide um payload já montado em partes determinísticas respeitando maxMessages e maxBytes.
//
// Regras:
// - Mensagens são ordenadas por (timestamp, external_id) antes de dividir — mesma entrada
//   sempre gera a mesma divisão.
// - Cada parte carrega part (1-based) e part_total corretos.
// - Nunca trunca silenciosamente: soma de mensagens entre as partes === total.
// - Uma única mensagem que sozinha excede maxBytes ainda é emitida como sua própria parte
//   (nunca é descartada) — nesse caso a parte pode ultrapassar maxBytes.
// - `conversations`: cada parte inclui somente as conversas cujos chats aparecem nas mensagens
//   daquela parte (subconjunto determinístico, evita repetir o array completo em toda parte).
export function chunkPayload(payload, { maxMessages = CHUNK_MAX_MESSAGES, maxBytes = CHUNK_MAX_BYTES } = {}) {
  const orderedMessages = sortMessagesDeterministically(payload.messages);
  const conversationsById = new Map(payload.conversations.map((c) => [c.chat_id, c]));

  const groups = [];
  let current = [];
  let currentBytes = baseEnvelopeBytes(payload);

  for (const msg of orderedMessages) {
    const msgBytes = jsonByteLength(msg);

    const wouldExceedCount = current.length >= maxMessages;
    const wouldExceedBytes = current.length > 0 && currentBytes + msgBytes > maxBytes;

    if (wouldExceedCount || wouldExceedBytes) {
      groups.push(current);
      current = [];
      currentBytes = baseEnvelopeBytes(payload);
    }

    current.push(msg);
    currentBytes += msgBytes;
  }
  if (current.length > 0 || groups.length === 0) {
    groups.push(current);
  }

  const partTotal = groups.length;

  return groups.map((groupMessages, idx) => {
    const chatIds = new Set(groupMessages.map((m) => m.chat_id));
    const conversationsForPart = payload.conversations.filter((c) => chatIds.has(c.chat_id));
    // preserva conversas cujo chat_id não bate com nenhum registro em conversationsById (não deveria
    // ocorrer em uso normal) — mantém apenas as presentes no map, já cobertas pelo filter acima.
    void conversationsById;

    return {
      schema_version: payload.schema_version,
      batch: {
        ...payload.batch,
        part: idx + 1,
        part_total: partTotal,
      },
      conversations: conversationsForPart,
      messages: groupMessages,
    };
  });
}

function jsonByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

// Tamanho aproximado do "envelope" (tudo exceto o array de mensagens) — usado como base ao somar
// bytes por parte. Aproximação suficiente para decidir limites de chunk (não precisa ser exato).
function baseEnvelopeBytes(payload) {
  return jsonByteLength({
    schema_version: payload.schema_version,
    batch: payload.batch,
    conversations: payload.conversations,
  });
}
