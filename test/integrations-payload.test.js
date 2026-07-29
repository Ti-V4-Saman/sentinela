// Payload builder + chunking determinístico (Etapa B — integração em lote).
// Sem DB/rede: testa apenas o módulo puro server/integrations/payload.js.
// Recebe arrays já carregados em memória (a query real vive em repo.js, Task 7/8).

import { describe, it, expect } from 'vitest';
import { buildPayload, chunkPayload, CHUNK_MAX_MESSAGES, CHUNK_MAX_BYTES } from '../server/integrations/payload.js';
import { idempotencyKey } from '../server/integrations/window.js';

const window = {
  start: new Date('2026-03-10T03:00:00.000Z'),
  end: new Date('2026-03-11T03:00:00.000Z'),
};

const tenant = { id: 42, name: 'Tenant Secreto', secret: 'nao-deveria-aparecer' };
const integration = {
  id: 7,
  include_audio_transcripts: false,
  target_url: 'https://example.com/hook',
  secret_hash: 'abc123hash',
  secret_masked: 'whsec_••••ab12',
};

function baseConversation(overrides = {}) {
  return {
    chat_id: 'chat-1',
    is_group: false,
    contact_ref: 'contact-abc',
    capture_wid: 'WID_SHOULD_NOT_LEAK',
    secret: 'super-secret-value',
    internal_note: 'nota interna confidencial',
    tenant_id_other: 99,
    ...overrides,
  };
}

function baseMessage(overrides = {}) {
  return {
    chat_id: 'chat-1',
    external_id: 'ext-1',
    from_me: false,
    type: 'text',
    timestamp: '2026-03-10T10:00:00.000Z',
    text: 'olá mundo',
    transcript: null,
    capture_wid: 'WID_SHOULD_NOT_LEAK',
    secret: 'super-secret-value',
    token: 'tok_should_not_leak',
    password: 'pw_should_not_leak',
    password_hash: 'ph_should_not_leak',
    internal_note: 'nota interna confidencial',
    tenant_id: 999, // tenant de outra linha — nunca deve vazar tal qual
    ...overrides,
  };
}

describe('payload — buildPayload allow-list', () => {
  it('nunca inclui campos proibidos no JSON serializado', () => {
    const conversations = [baseConversation()];
    const messages = [baseMessage()];

    const payload = buildPayload({ tenant, integration, window, conversations, messages, schemaVersion: 1 });
    const json = JSON.stringify(payload);

    for (const forbidden of [
      'capture_wid',
      'WID_SHOULD_NOT_LEAK',
      'secret',
      'super-secret-value',
      'token',
      'tok_should_not_leak',
      'password',
      'pw_should_not_leak',
      'password_hash',
      'ph_should_not_leak',
      'internal_note',
      'nota interna confidencial',
      'nao-deveria-aparecer',
      'abc123hash',
    ]) {
      expect(json).not.toContain(forbidden);
    }
  });

  it('produz somente as chaves permitidas em conversations e messages', () => {
    const conversations = [baseConversation()];
    const messages = [baseMessage()];
    const payload = buildPayload({ tenant, integration, window, conversations, messages, schemaVersion: 1 });

    expect(Object.keys(payload).sort()).toEqual(['batch', 'conversations', 'messages', 'schema_version'].sort());
    expect(Object.keys(payload.batch).sort()).toEqual(
      ['tenant_id', 'window_start', 'window_end', 'part', 'part_total'].sort()
    );

    const convKeys = Object.keys(payload.conversations[0]).sort();
    for (const k of convKeys) {
      expect(['chat_id', 'is_group', 'contact_ref']).toContain(k);
    }

    const msgKeys = Object.keys(payload.messages[0]).sort();
    for (const k of msgKeys) {
      expect(['chat_id', 'external_id', 'direction', 'type', 'timestamp', 'text', 'transcript']).toContain(k);
    }
  });

  it('omite contact_ref quando ausente na conversa fonte', () => {
    const conversations = [{ chat_id: 'chat-2', is_group: true }];
    const payload = buildPayload({ tenant, integration, window, conversations, messages: [], schemaVersion: 1 });
    expect(payload.conversations[0]).toEqual({ chat_id: 'chat-2', is_group: true });
    expect('contact_ref' in payload.conversations[0]).toBe(false);
  });

  it('batch traz tenant_id, window ISO e part/part_total default 1', () => {
    const payload = buildPayload({ tenant, integration, window, conversations: [], messages: [], schemaVersion: 1 });
    expect(payload.batch.tenant_id).toBe(42);
    expect(payload.batch.window_start).toBe(window.start.toISOString());
    expect(payload.batch.window_end).toBe(window.end.toISOString());
    expect(payload.batch.part).toBe(1);
    expect(payload.batch.part_total).toBe(1);
    expect(payload.schema_version).toBe(1);
  });

  it("direction é 'out' quando from_me é truthy e 'in' quando falsy", () => {
    const messages = [
      baseMessage({ external_id: 'a', from_me: true }),
      baseMessage({ external_id: 'b', from_me: false }),
      baseMessage({ external_id: 'c', from_me: 1 }),
      baseMessage({ external_id: 'd', from_me: 0 }),
    ];
    const payload = buildPayload({ tenant, integration, window, conversations: [], messages, schemaVersion: 1 });
    const byId = Object.fromEntries(payload.messages.map((m) => [m.external_id, m.direction]));
    expect(byId.a).toBe('out');
    expect(byId.b).toBe('in');
    expect(byId.c).toBe('out');
    expect(byId.d).toBe('in');
  });

  it('inclui text quando presente na origem', () => {
    const messages = [baseMessage({ text: 'conteúdo da mensagem' })];
    const payload = buildPayload({ tenant, integration, window, conversations: [], messages, schemaVersion: 1 });
    expect(payload.messages[0].text).toBe('conteúdo da mensagem');
  });

  it('omite text quando ausente na origem', () => {
    const messages = [baseMessage({ text: null })];
    const payload = buildPayload({ tenant, integration, window, conversations: [], messages, schemaVersion: 1 });
    expect('text' in payload.messages[0]).toBe(false);
  });

  it('inclui transcript somente quando include_audio_transcripts=true e a linha é áudio com transcript', () => {
    const audioMsg = baseMessage({
      external_id: 'audio-1',
      type: 'audio',
      text: null,
      transcript: 'transcrição do áudio',
    });

    const withFlagOn = buildPayload({
      tenant,
      integration: { ...integration, include_audio_transcripts: true },
      window,
      conversations: [],
      messages: [audioMsg],
      schemaVersion: 1,
    });
    expect(withFlagOn.messages[0].transcript).toBe('transcrição do áudio');

    const withFlagOff = buildPayload({
      tenant,
      integration: { ...integration, include_audio_transcripts: false },
      window,
      conversations: [],
      messages: [audioMsg],
      schemaVersion: 1,
    });
    expect('transcript' in withFlagOff.messages[0]).toBe(false);
  });

  it('não inclui transcript em mensagem de áudio com flag ligada mas sem transcript na origem', () => {
    const audioMsg = baseMessage({ external_id: 'audio-2', type: 'audio', text: null, transcript: null });
    const payload = buildPayload({
      tenant,
      integration: { ...integration, include_audio_transcripts: true },
      window,
      conversations: [],
      messages: [audioMsg],
      schemaVersion: 1,
    });
    expect('transcript' in payload.messages[0]).toBe(false);
  });

  it('não inclui transcript em mensagem não-áudio mesmo com flag ligada e transcript presente', () => {
    const textMsg = baseMessage({ external_id: 'txt-1', type: 'text', transcript: 'não deveria aparecer' });
    const payload = buildPayload({
      tenant,
      integration: { ...integration, include_audio_transcripts: true },
      window,
      conversations: [],
      messages: [textMsg],
      schemaVersion: 1,
    });
    expect('transcript' in payload.messages[0]).toBe(false);
  });
});

describe('payload — chunkPayload', () => {
  function buildMessages(n) {
    return Array.from({ length: n }, (_, i) => ({
      chat_id: `chat-${i % 3}`,
      external_id: `ext-${String(n - i).padStart(4, '0')}`, // ordem de inserção != ordem esperada
      from_me: i % 2 === 0,
      type: 'text',
      timestamp: new Date(window.start.getTime() + i * 1000).toISOString(),
      text: `mensagem ${i}`,
    }));
  }

  it('divide em partes determinísticas por contagem (maxMessages=2, 5 mensagens -> 3 partes 2+2+1)', () => {
    const messages = buildMessages(5);
    const conversations = [{ chat_id: 'chat-0', is_group: false }, { chat_id: 'chat-1', is_group: false }, { chat_id: 'chat-2', is_group: false }];
    const payload = buildPayload({ tenant, integration, window, conversations, messages, schemaVersion: 1 });

    const parts = chunkPayload(payload, { maxMessages: 2, maxBytes: CHUNK_MAX_BYTES });
    expect(parts).toHaveLength(3);
    expect(parts.map((p) => p.messages.length)).toEqual([2, 2, 1]);
    parts.forEach((p, idx) => {
      expect(p.batch.part).toBe(idx + 1);
      expect(p.batch.part_total).toBe(3);
    });

    const totalMessages = parts.reduce((acc, p) => acc + p.messages.length, 0);
    expect(totalMessages).toBe(5);

    // concatenação de todas as partes === conjunto original ordenado, sem perda nem duplicata
    const allExternalIds = parts.flatMap((p) => p.messages.map((m) => m.external_id));
    const expectedOrdered = [...messages]
      .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.external_id < b.external_id ? -1 : 1))
      .map((m) => m.external_id);
    expect(allExternalIds).toEqual(expectedOrdered);
    expect(new Set(allExternalIds).size).toBe(5);
  });

  it('é determinística: mesma entrada produz sempre a mesma divisão', () => {
    const messages = buildMessages(5);
    const conversations = [{ chat_id: 'chat-0', is_group: false }];
    const payload = buildPayload({ tenant, integration, window, conversations, messages, schemaVersion: 1 });

    const parts1 = chunkPayload(payload, { maxMessages: 2, maxBytes: CHUNK_MAX_BYTES });
    const parts2 = chunkPayload(payload, { maxMessages: 2, maxBytes: CHUNK_MAX_BYTES });

    expect(parts1.map((p) => p.messages.map((m) => m.external_id))).toEqual(
      parts2.map((p) => p.messages.map((m) => m.external_id))
    );
  });

  it('quando não excede limites, retorna uma única parte com part=1/part_total=1', () => {
    const messages = buildMessages(3);
    const payload = buildPayload({ tenant, integration, window, conversations: [], messages, schemaVersion: 1 });
    const parts = chunkPayload(payload, { maxMessages: CHUNK_MAX_MESSAGES, maxBytes: CHUNK_MAX_BYTES });
    expect(parts).toHaveLength(1);
    expect(parts[0].batch.part).toBe(1);
    expect(parts[0].batch.part_total).toBe(1);
    expect(parts[0].messages).toHaveLength(3);
  });

  it('divide por tamanho em bytes quando maxBytes é pequeno', () => {
    const messages = buildMessages(10).map((m) => ({ ...m, text: 'x'.repeat(500) }));
    const payload = buildPayload({ tenant, integration, window, conversations: [], messages, schemaVersion: 1 });

    // cada mensagem serializada ocupa bem mais que ~600 bytes; força múltiplas partes
    const parts = chunkPayload(payload, { maxMessages: CHUNK_MAX_MESSAGES, maxBytes: 900 });
    expect(parts.length).toBeGreaterThan(1);

    const totalMessages = parts.reduce((acc, p) => acc + p.messages.length, 0);
    expect(totalMessages).toBe(10);
    parts.forEach((p, idx) => {
      expect(p.batch.part).toBe(idx + 1);
      expect(p.batch.part_total).toBe(parts.length);
    });
  });

  it('uma única mensagem que excede maxBytes sozinha ainda vira sua própria parte (nunca é descartada)', () => {
    const hugeMessage = {
      chat_id: 'chat-0',
      external_id: 'ext-huge',
      from_me: false,
      type: 'text',
      timestamp: window.start.toISOString(),
      text: 'y'.repeat(10000),
    };
    const smallMessage = {
      chat_id: 'chat-0',
      external_id: 'ext-small',
      from_me: false,
      type: 'text',
      timestamp: new Date(window.start.getTime() + 1000).toISOString(),
      text: 'pequena',
    };
    const payload = buildPayload({
      tenant,
      integration,
      window,
      conversations: [],
      messages: [hugeMessage, smallMessage],
      schemaVersion: 1,
    });

    const parts = chunkPayload(payload, { maxMessages: CHUNK_MAX_MESSAGES, maxBytes: 500 });
    const allIds = parts.flatMap((p) => p.messages.map((m) => m.external_id));
    expect(allIds).toContain('ext-huge');
    expect(allIds).toContain('ext-small');
    expect(new Set(allIds).size).toBe(2);

    const hugePart = parts.find((p) => p.messages.some((m) => m.external_id === 'ext-huge'));
    expect(hugePart.messages).toHaveLength(1);
  });

  it('idempotencyKey recomputada por parte é distinta entre partes e consistente com window.idempotencyKey', () => {
    const messages = buildMessages(5);
    const payload = buildPayload({ tenant, integration, window, conversations: [], messages, schemaVersion: 1 });
    const parts = chunkPayload(payload, { maxMessages: 2, maxBytes: CHUNK_MAX_BYTES });

    const keys = parts.map((p) =>
      idempotencyKey({
        tenantId: p.batch.tenant_id,
        integrationId: integration.id,
        windowStart: new Date(p.batch.window_start),
        windowEnd: new Date(p.batch.window_end),
        schemaVersion: p.schema_version,
        part: p.batch.part,
      })
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('conversations em cada parte contém apenas os chats presentes nas mensagens daquela parte (determinístico)', () => {
    const messages = buildMessages(5); // chat-0, chat-1, chat-2, chat-0, chat-1
    const conversations = [
      { chat_id: 'chat-0', is_group: false },
      { chat_id: 'chat-1', is_group: false },
      { chat_id: 'chat-2', is_group: true },
    ];
    const payload = buildPayload({ tenant, integration, window, conversations, messages, schemaVersion: 1 });
    const parts = chunkPayload(payload, { maxMessages: 2, maxBytes: CHUNK_MAX_BYTES });

    parts.forEach((p) => {
      const chatIdsInPart = new Set(p.messages.map((m) => m.chat_id));
      const chatIdsInConversations = new Set(p.conversations.map((c) => c.chat_id));
      expect(chatIdsInConversations).toEqual(chatIdsInPart);
    });
  });
});
