import express from 'express';
import { requireActor } from '../middleware/actor.js';
import {
  visibleCaptureWids, conversationTenantFilter, messageTextSearch,
} from '../middleware/conversationScope.js';

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

function parsePaging(q) {
  let limit = parseInt(q.limit, 10);
  if (Number.isNaN(limit) || limit < 1) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;
  let page = parseInt(q.page, 10);
  if (Number.isNaN(page) || page < 1) page = 1;
  return { page, limit, offset: (page - 1) * limit };
}

// '0'|'1'|'false'|'true' → 0/1; ausente/'' → null; inválido → NaN (marca 400).
function parseBool(v) {
  if (v === undefined || v === '') return null;
  if (v === '1' || v === 'true') return 1;
  if (v === '0' || v === 'false') return 0;
  return NaN;
}

// Valida data (ISO ou YYYY-MM-DD). undefined/'' → null; inválida → false.
function parseDate(v) {
  if (v === undefined || v === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return false;
  return v; // string original; MySQL parseia ISO / 'YYYY-MM-DD ...'
}

// Direção da mensagem a partir de from_me (0/1). Diferencia enviada x recebida.
const direction = (fromMe) => (Number(fromMe) === 1 ? 'outgoing' : 'incoming');

export function createChatsRouter(pool) {
  const router = express.Router();
  router.use(requireActor(pool)); // qualquer papel ativo; escopo abaixo é per-role.

  // Resolve o conjunto de wids de captura visíveis + o filtro opcional por instância.
  // Retorna { widScope: 'ALL' | string[], empty: boolean } — empty=true ⇒ nada a consultar.
  async function resolveWidScope(actor, instanceIdParam) {
    let widScope = await visibleCaptureWids(pool, actor); // 'ALL' | string[]

    if (instanceIdParam) {
      // instance_id refere a sentinela_instances.id (instância gerenciada). Traduz p/ capture_wid.
      const args = [instanceIdParam];
      let sql = 'SELECT capture_wid, tenant_id FROM sentinela_instances WHERE id = ?';
      if (actor.role !== 'superadmin') { sql += ' AND tenant_id = ?'; args.push(actor.tenant_id); }
      const [rows] = await pool.query(sql, args);
      const iwid = rows[0]?.capture_wid || null;
      if (!iwid) return { widScope: [], empty: true }; // não mapeada / fora do escopo → fail-closed
      if (widScope !== 'ALL' && !widScope.includes(iwid)) return { widScope: [], empty: true };
      widScope = [iwid];
    }

    const empty = widScope !== 'ALL' && widScope.length === 0;
    return { widScope, empty };
  }

  // ---- GET /api/chats — listagem paginada de conversas ----
  router.get('/', async (req, res) => {
    try {
      const { page, limit, offset } = parsePaging(req.query);
      const isGroup = parseBool(req.query.is_group);
      if (Number.isNaN(isGroup)) return res.status(400).json({ error: 'is_group inválido (use 0 ou 1)' });
      const dateFrom = parseDate(req.query.date_from);
      const dateTo = parseDate(req.query.date_to);
      if (dateFrom === false || dateTo === false) return res.status(400).json({ error: 'date_from/date_to inválidos' });
      const search = (req.query.search || '').trim();

      const { widScope, empty } = await resolveWidScope(req.actor, req.query.instance_id);
      if (empty) return res.json({ page, limit, total: 0, chats: [] }); // fail-closed: não consulta mensagens

      // CTE: última mensagem + contagem por (tenant, chat), já escopada por tenant/wid.
      const cteWhere = [], cteArgs = [];
      const tf = conversationTenantFilter(req.actor, 'm.');
      if (tf.sql) { cteWhere.push(tf.sql); cteArgs.push(...tf.params); }
      if (widScope !== 'ALL') {
        cteWhere.push(`m.wid IN (${widScope.map(() => '?').join(',')})`);
        cteArgs.push(...widScope);
      }
      const cteClause = cteWhere.length ? `WHERE ${cteWhere.join(' AND ')}` : '';

      const cte = `
        WITH msg AS (
          SELECT m.tenant_id, m.chat_id, m.id, m.text, m.type, m.timestamp, m.wid, m.contact_id, m.from_me,
                 ROW_NUMBER() OVER (PARTITION BY m.tenant_id, m.chat_id ORDER BY m.timestamp DESC, m.id DESC) AS rn,
                 COUNT(*)     OVER (PARTITION BY m.tenant_id, m.chat_id) AS message_count,
                 MAX(m.timestamp) OVER (PARTITION BY m.tenant_id, m.chat_id) AS last_ts
          FROM messages m ${cteClause}
        )`;

      // Filtros aplicados na projeção final (linha da última mensagem, rn=1).
      const outWhere = ['msg.rn = 1'], outArgs = [];
      if (isGroup !== null) { outWhere.push('c.is_group = ?'); outArgs.push(isGroup); }
      if (search) { outWhere.push('(ct.name LIKE ? OR ct.phone LIKE ?)'); outArgs.push(`%${search}%`, `%${search}%`); }
      if (dateFrom) { outWhere.push('msg.last_ts >= ?'); outArgs.push(dateFrom); }
      if (dateTo) { outWhere.push('msg.last_ts <= ?'); outArgs.push(dateTo); }
      const outClause = outWhere.join(' AND ');

      const joins = `
        FROM msg
        JOIN chats c ON c.tenant_id = msg.tenant_id AND c.id = msg.chat_id
        LEFT JOIN contacts ct ON ct.tenant_id = msg.tenant_id AND ct.id = msg.contact_id
        LEFT JOIN sentinela_instances si ON si.capture_wid = msg.wid`;

      const [countRows] = await pool.query(
        `${cte} SELECT COUNT(*) AS total ${joins} WHERE ${outClause}`,
        [...cteArgs, ...outArgs]);
      const total = countRows[0].total;

      const [rows] = await pool.query(
        `${cte}
         SELECT c.id AS chat_id, c.title, c.is_group,
                msg.text AS last_message_text, msg.type AS last_message_type,
                msg.from_me AS last_from_me, msg.timestamp AS last_activity, msg.message_count,
                ct.id AS contact_id, ct.name AS contact_name, ct.phone AS contact_phone,
                si.id AS instance_id, si.name AS instance_name
         ${joins}
         WHERE ${outClause}
         ORDER BY msg.last_ts DESC, msg.tenant_id, msg.chat_id
         LIMIT ? OFFSET ?`,
        [...cteArgs, ...outArgs, limit, offset]);

      const chats = rows.map((r) => ({
        id: r.chat_id,
        title: r.title || r.contact_name || null,
        isGroup: Number(r.is_group) === 1,
        contact: { id: r.contact_id, name: r.contact_name || null, phone: r.contact_phone || null },
        instance: { id: r.instance_id || null, name: r.instance_name || null },
        lastMessage: {
          text: r.last_message_text,
          type: r.last_message_type,
          direction: direction(r.last_from_me),
          at: r.last_activity,
        },
        messageCount: Number(r.message_count),
        lastActivityAt: r.last_activity,
      }));

      res.json({ page, limit, total, chats });
    } catch (e) {
      console.error('list chats:', e);
      res.status(500).json({ error: 'Falha ao listar conversas' });
    }
  });

  // ---- GET /api/chats/:id/messages — thread paginada de uma conversa ----
  router.get('/:id/messages', async (req, res) => {
    try {
      const chatId = req.params.id;
      const { page, limit, offset } = parsePaging(req.query);
      const type = (req.query.type || '').trim();
      const dateFrom = parseDate(req.query.date_from);
      const dateTo = parseDate(req.query.date_to);
      if (dateFrom === false || dateTo === false) return res.status(400).json({ error: 'date_from/date_to inválidos' });
      const search = (req.query.search || '').trim();

      const { widScope, empty } = await resolveWidScope(req.actor, req.query.instance_id);
      // Chat fora do escopo / sem instância visível é indistinguível de inexistente → 404.
      if (empty) return res.status(404).json({ error: 'Conversa não encontrada' });

      // Localiza o chat DENTRO do escopo (tenant + wid). Sem vazar existência entre tenants.
      const locWhere = ['c.id = ?'], locArgs = [chatId];
      const tf = conversationTenantFilter(req.actor, 'c.');
      if (tf.sql) { locWhere.push(tf.sql); locArgs.push(...tf.params); }
      const [chatRows] = await pool.query(
        `SELECT c.tenant_id, c.id, c.title, c.is_group FROM chats c WHERE ${locWhere.join(' AND ')}`, locArgs);
      if (chatRows.length === 0) return res.status(404).json({ error: 'Conversa não encontrada' });
      if (chatRows.length > 1) return res.status(400).json({ error: 'chat_id ambíguo entre tenants; informe instance_id' });
      const chat = chatRows[0];

      // Para gestor/usuário: o chat só é visível se tiver mensagem numa instância visível.
      if (widScope !== 'ALL') {
        const [vis] = await pool.query(
          `SELECT 1 FROM messages m WHERE m.tenant_id = ? AND m.chat_id = ?
             AND m.wid IN (${widScope.map(() => '?').join(',')}) LIMIT 1`,
          [chat.tenant_id, chat.id, ...widScope]);
        if (vis.length === 0) return res.status(404).json({ error: 'Conversa não encontrada' });
      }

      // Query das mensagens (escopada). wid IN visível como defesa em profundidade.
      const where = ['m.tenant_id = ?', 'm.chat_id = ?'], args = [chat.tenant_id, chat.id];
      if (widScope !== 'ALL') { where.push(`m.wid IN (${widScope.map(() => '?').join(',')})`); args.push(...widScope); }
      if (type) { where.push('m.type = ?'); args.push(type); }
      if (dateFrom) { where.push('m.timestamp >= ?'); args.push(dateFrom); }
      if (dateTo) { where.push('m.timestamp <= ?'); args.push(dateTo); }
      const ts = messageTextSearch('m.text', search);
      if (ts.sql) { where.push(ts.sql); args.push(...ts.params); }
      const clause = where.join(' AND ');

      const [countRows] = await pool.query(`SELECT COUNT(*) AS total FROM messages m WHERE ${clause}`, args);
      const total = countRows[0].total;

      const [rows] = await pool.query(
        `SELECT m.id, m.chat_id, m.type, m.text, m.from_me, m.from_internal, m.timestamp,
                m.contact_id, ct.name AS contact_name, ct.phone AS contact_phone
         FROM messages m
         LEFT JOIN contacts ct ON ct.tenant_id = m.tenant_id AND ct.id = m.contact_id
         WHERE ${clause}
         ORDER BY m.timestamp ASC, m.id ASC
         LIMIT ? OFFSET ?`,
        [...args, limit, offset]);

      const messages = rows.map((r) => ({
        id: r.id,
        chatId: r.chat_id,
        type: r.type,
        text: r.text, // conteúdo ou transcrição (áudio: type='audio')
        direction: direction(r.from_me),
        fromMe: Number(r.from_me) === 1,
        fromInternal: Number(r.from_internal) === 1,
        sender: Number(r.from_me) === 1
          ? { self: true }
          : { contactId: r.contact_id, name: r.contact_name || null, phone: r.contact_phone || null },
        at: r.timestamp,
      }));

      res.json({
        chat: { id: chat.id, title: chat.title || null, isGroup: Number(chat.is_group) === 1 },
        page, limit, total, messages,
      });
    } catch (e) {
      console.error('list chat messages:', e);
      res.status(500).json({ error: 'Falha ao listar mensagens' });
    }
  });

  return router;
}
