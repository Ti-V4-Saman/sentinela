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

const pad = (n) => String(n).padStart(2, '0');

// Normaliza data para o formato do MySQL e rejeita formatos ambíguos.
// Retorna null (não fornecida), false (inválida) ou { op, value }.
//  - `YYYY-MM-DD`: date_from → '>= dia 00:00:00'; date_to → '< dia seguinte 00:00:00'
//    (limite EXCLUSIVO ⇒ inclui o dia inteiro).
//  - datetime ISO / 'YYYY-MM-DD HH:MM[:SS]': inclusivo ('>=' / '<='). TZ/frações são
//    descartadas (comparação wall-clock, consistente com o armazenamento).
function parseDateBound(value, isEnd) {
  if (value === undefined || value === '') return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return false;
    if (isEnd) {
      const nx = new Date(Date.UTC(y, m - 1, d + 1));
      const nv = `${nx.getUTCFullYear()}-${pad(nx.getUTCMonth() + 1)}-${pad(nx.getUTCDate())}`;
      return { op: '<', value: `${nv} 00:00:00` };
    }
    return { op: '>=', value: `${value} 00:00:00` };
  }

  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/.exec(value);
  if (m) {
    const [, date, hh, mm, ss] = m;
    return { op: isEnd ? '<=' : '>=', value: `${date} ${hh}:${mm}:${ss || '00'}` };
  }
  return false; // ambíguo / não suportado
}

// Referência opaca de navegação: encapsula (tenant_id, chat_id) sem expor tenant_id como
// campo legível. Não é fronteira de segurança — o RBAC é revalidado a cada requisição.
function encodeRef(tenantId, chatId) {
  return Buffer.from(JSON.stringify([tenantId, chatId]), 'utf8').toString('base64url');
}
function decodeRef(s) {
  try {
    const arr = JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8'));
    if (Array.isArray(arr) && arr.length === 2 && Number.isInteger(arr[0]) && typeof arr[1] === 'string') {
      return { tenantId: arr[0], chatId: arr[1] };
    }
  } catch { /* não é um ref */ }
  return null;
}

const direction = (fromMe) => (Number(fromMe) === 1 ? 'outgoing' : 'incoming');

export function createChatsRouter(pool) {
  const router = express.Router();
  router.use(requireActor(pool));

  // Resolve wids de captura visíveis + filtro opcional por instância (sentinela_instances.id).
  async function resolveWidScope(actor, instanceIdParam) {
    let widScope = await visibleCaptureWids(pool, actor); // 'ALL' | string[]
    if (instanceIdParam) {
      const args = [instanceIdParam];
      let sql = 'SELECT capture_wid FROM sentinela_instances WHERE id = ?';
      if (actor.role !== 'superadmin') { sql += ' AND tenant_id = ?'; args.push(actor.tenant_id); }
      const [rows] = await pool.query(sql, args);
      const iwid = rows[0]?.capture_wid || null;
      if (!iwid) return { widScope: [], empty: true };
      if (widScope !== 'ALL' && !widScope.includes(iwid)) return { widScope: [], empty: true };
      widScope = [iwid];
    }
    const empty = widScope !== 'ALL' && widScope.length === 0;
    return { widScope, empty };
  }

  // ---- GET /api/chats ----
  router.get('/', async (req, res) => {
    try {
      const { page, limit, offset } = parsePaging(req.query);
      const isGroup = parseBool(req.query.is_group);
      if (Number.isNaN(isGroup)) return res.status(400).json({ error: 'is_group inválido (use 0 ou 1)' });
      const dFrom = parseDateBound(req.query.date_from, false);
      const dTo = parseDateBound(req.query.date_to, true);
      if (dFrom === false || dTo === false) return res.status(400).json({ error: 'date_from/date_to inválidos (use YYYY-MM-DD ou ISO datetime)' });
      const search = (req.query.search || '').trim();

      const { widScope, empty } = await resolveWidScope(req.actor, req.query.instance_id);
      if (empty) return res.json({ page, limit, total: 0, chats: [] });

      const cteWhere = [], cteArgs = [];
      const tf = conversationTenantFilter(req.actor, 'm.');
      if (tf.sql) { cteWhere.push(tf.sql); cteArgs.push(...tf.params); }
      if (widScope !== 'ALL') { cteWhere.push(`m.wid IN (${widScope.map(() => '?').join(',')})`); cteArgs.push(...widScope); }
      const cteClause = cteWhere.length ? `WHERE ${cteWhere.join(' AND ')}` : '';
      const contactClause = cteWhere.length
        ? `WHERE ${cteWhere.join(' AND ')} AND m.contact_id IS NOT NULL`
        : 'WHERE m.contact_id IS NOT NULL';

      // Última mensagem/contagem por chat; contato = mensagem NÃO-nula mais recente do chat
      // (independente da última mensagem, que pode ser enviada/interna/sem contato).
      const cte = `
        WITH msg AS (
          SELECT m.tenant_id, m.chat_id, m.id, m.text, m.type, m.timestamp, m.wid, m.from_me,
                 ROW_NUMBER() OVER (PARTITION BY m.tenant_id, m.chat_id ORDER BY m.timestamp DESC, m.id DESC) AS rn,
                 COUNT(*)     OVER (PARTITION BY m.tenant_id, m.chat_id) AS message_count,
                 MAX(m.timestamp) OVER (PARTITION BY m.tenant_id, m.chat_id) AS last_ts
          FROM messages m ${cteClause}
        ),
        contact_pick AS (
          SELECT tenant_id, chat_id, contact_id FROM (
            SELECT m.tenant_id, m.chat_id, m.contact_id,
                   ROW_NUMBER() OVER (PARTITION BY m.tenant_id, m.chat_id ORDER BY m.timestamp DESC, m.id DESC) AS crn
            FROM messages m ${contactClause}
          ) z WHERE z.crn = 1
        )`;

      const outWhere = ['msg.rn = 1'], outArgs = [];
      if (isGroup !== null) { outWhere.push('c.is_group = ?'); outArgs.push(isGroup); }
      if (search) { outWhere.push('(ct.name LIKE ? OR ct.phone LIKE ?)'); outArgs.push(`%${search}%`, `%${search}%`); }
      if (dFrom) { outWhere.push(`msg.last_ts ${dFrom.op} ?`); outArgs.push(dFrom.value); }
      if (dTo) { outWhere.push(`msg.last_ts ${dTo.op} ?`); outArgs.push(dTo.value); }
      const outClause = outWhere.join(' AND ');

      const joins = `
        FROM msg
        JOIN chats c ON c.tenant_id = msg.tenant_id AND c.id = msg.chat_id
        LEFT JOIN contact_pick cp ON cp.tenant_id = msg.tenant_id AND cp.chat_id = msg.chat_id
        LEFT JOIN contacts ct ON ct.tenant_id = msg.tenant_id AND ct.id = cp.contact_id
        LEFT JOIN sentinela_instances si ON si.capture_wid = msg.wid`;

      const [countRows] = await pool.query(
        `${cte} SELECT COUNT(*) AS total ${joins} WHERE ${outClause}`,
        [...cteArgs, ...cteArgs, ...outArgs]);
      const total = countRows[0].total;

      const [rows] = await pool.query(
        `${cte}
         SELECT msg.tenant_id, c.id AS chat_id, c.title, c.is_group,
                msg.text AS last_message_text, msg.type AS last_message_type,
                msg.from_me AS last_from_me, msg.timestamp AS last_activity, msg.message_count,
                ct.id AS contact_id, ct.name AS contact_name, ct.phone AS contact_phone,
                si.id AS instance_id, si.name AS instance_name
         ${joins}
         WHERE ${outClause}
         ORDER BY msg.last_ts DESC, msg.tenant_id, msg.chat_id
         LIMIT ? OFFSET ?`,
        [...cteArgs, ...cteArgs, ...outArgs, limit, offset]);

      const chats = rows.map((r) => ({
        id: r.chat_id,
        ref: encodeRef(Number(r.tenant_id), r.chat_id), // usar no detalhe (sem ambiguidade)
        title: r.title || r.contact_name || null,
        isGroup: Number(r.is_group) === 1,
        contact: { id: r.contact_id || null, name: r.contact_name || null, phone: r.contact_phone || null },
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

  // ---- GET /api/chats/:id/messages ----
  // :id aceita o `ref` opaco (recomendado, retornado na listagem) OU o chat_id cru.
  router.get('/:id/messages', async (req, res) => {
    try {
      const { page, limit, offset } = parsePaging(req.query);
      const type = (req.query.type || '').trim();
      const dFrom = parseDateBound(req.query.date_from, false);
      const dTo = parseDateBound(req.query.date_to, true);
      if (dFrom === false || dTo === false) return res.status(400).json({ error: 'date_from/date_to inválidos' });
      const search = (req.query.search || '').trim();

      const { widScope, empty } = await resolveWidScope(req.actor, req.query.instance_id);
      if (empty) return res.status(404).json({ error: 'Conversa não encontrada' });

      // Resolve o chat: por ref (tenant+chat explícitos) ou por chat_id cru (escopado).
      let chat;
      const decoded = decodeRef(req.params.id);
      if (decoded) {
        if (req.actor.role !== 'superadmin' && Number(decoded.tenantId) !== Number(req.actor.tenant_id)) {
          return res.status(404).json({ error: 'Conversa não encontrada' });
        }
        const [rows] = await pool.query(
          'SELECT tenant_id, id, title, is_group FROM chats WHERE tenant_id = ? AND id = ?',
          [decoded.tenantId, decoded.chatId]);
        chat = rows[0];
      } else {
        const where = ['c.id = ?'], args = [req.params.id];
        const tf = conversationTenantFilter(req.actor, 'c.');
        if (tf.sql) { where.push(tf.sql); args.push(...tf.params); }
        const [rows] = await pool.query(
          `SELECT c.tenant_id, c.id, c.title, c.is_group FROM chats c WHERE ${where.join(' AND ')}`, args);
        if (rows.length > 1) {
          return res.status(400).json({ error: 'chat_id ambíguo entre tenants; use o campo "ref" da listagem' });
        }
        chat = rows[0];
      }
      if (!chat) return res.status(404).json({ error: 'Conversa não encontrada' });

      // Gestor/usuário: chat só é visível se tiver mensagem numa instância visível.
      if (widScope !== 'ALL') {
        const [vis] = await pool.query(
          `SELECT 1 FROM messages m WHERE m.tenant_id = ? AND m.chat_id = ?
             AND m.wid IN (${widScope.map(() => '?').join(',')}) LIMIT 1`,
          [chat.tenant_id, chat.id, ...widScope]);
        if (vis.length === 0) return res.status(404).json({ error: 'Conversa não encontrada' });
      }

      const where = ['m.tenant_id = ?', 'm.chat_id = ?'], args = [chat.tenant_id, chat.id];
      if (widScope !== 'ALL') { where.push(`m.wid IN (${widScope.map(() => '?').join(',')})`); args.push(...widScope); }
      if (type) { where.push('m.type = ?'); args.push(type); }
      if (dFrom) { where.push(`m.timestamp ${dFrom.op} ?`); args.push(dFrom.value); }
      if (dTo) { where.push(`m.timestamp ${dTo.op} ?`); args.push(dTo.value); }
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
        text: r.text,
        direction: direction(r.from_me),
        fromMe: Number(r.from_me) === 1,
        fromInternal: Number(r.from_internal) === 1,
        sender: Number(r.from_me) === 1
          ? { self: true }
          : { contactId: r.contact_id || null, name: r.contact_name || null, phone: r.contact_phone || null },
        at: r.timestamp,
      }));

      res.json({
        chat: { id: chat.id, ref: encodeRef(Number(chat.tenant_id), chat.id), title: chat.title || null, isGroup: Number(chat.is_group) === 1 },
        page, limit, total, messages,
      });
    } catch (e) {
      console.error('list chat messages:', e);
      res.status(500).json({ error: 'Falha ao listar mensagens' });
    }
  });

  return router;
}
