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

// Valida ano/mês/dia/hora/min/seg reais (inclui bissexto). h 00–23, mi/s 00–59.
function isValidCalendar(y, mo, d, h, mi, s) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
    && dt.getUTCHours() === h && dt.getUTCMinutes() === mi && dt.getUTCSeconds() === s;
}

// Normaliza data para o formato do MySQL (horário do banco, SEM timezone) e valida
// semanticamente. Formatos aceitos: `YYYY-MM-DD`, `YYYY-MM-DDTHH:mm[:ss]`, `YYYY-MM-DD HH:mm[:ss]`.
// Retorna:
//   null           → não fornecida
//   'tz'           → veio com Z/offset (rejeitado: não descartamos timezone silenciosamente)
//   false          → formato/semântica inválidos
//   { op, value }  → válido. `YYYY-MM-DD`: from '>= dia 00:00:00'; to '< dia seguinte' (inclui o
//                    dia inteiro). Datetime: inclusivo ('>=' / '<=').
function parseDateBound(value, isEnd) {
  if (value === undefined || value === '') return null;

  // Data pura YYYY-MM-DD
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (!isValidCalendar(y, mo, d, 0, 0, 0)) return false;
    if (isEnd) {
      const nx = new Date(Date.UTC(y, mo - 1, d + 1));
      const nv = `${nx.getUTCFullYear()}-${pad(nx.getUTCMonth() + 1)}-${pad(nx.getUTCDate())}`;
      return { op: '<', value: `${nv} 00:00:00` };
    }
    return { op: '>=', value: `${m[1]}-${m[2]}-${m[3]} 00:00:00` };
  }

  // Datetime SEM timezone: 'YYYY-MM-DD' + (T|espaço) + HH:mm(:ss)?
  m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5], s = m[6] !== undefined ? +m[6] : 0;
    if (!isValidCalendar(y, mo, d, h, mi, s)) return false;
    return { op: isEnd ? '<=' : '>=', value: `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6] ?? '00'}` };
  }

  // Datetime COM timezone (Z ou ±HH:MM) e/ou fração → rejeita explicitamente (não descarta o fuso).
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) return 'tz';

  return false;
}

// Mensagem de 400 para um limite de data inválido; null se válido/ausente.
function dateBoundError(d) {
  if (d === 'tz') return 'datetime com timezone não é aceito; use horário sem timezone (YYYY-MM-DD ou YYYY-MM-DDTHH:mm:ss)';
  if (d === false) return 'date_from/date_to inválidos (use YYYY-MM-DD ou YYYY-MM-DDTHH:mm:ss, sem timezone)';
  return null;
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

  // capture_wids (não-nulos) de uma entidade, escopados ao tenant do ator (non-super).
  const tenantSql = (actor) => (actor.role !== 'superadmin' ? ' AND si.tenant_id = ?' : '');
  async function widsForInstance(actor, id) {
    const args = [id]; let sql = 'SELECT capture_wid FROM sentinela_instances si WHERE si.id = ? AND si.capture_wid IS NOT NULL';
    if (actor.role !== 'superadmin') { sql += ' AND si.tenant_id = ?'; args.push(actor.tenant_id); }
    const [rows] = await pool.query(sql, args); return rows.map((r) => r.capture_wid);
  }
  async function widsForTeam(actor, teamId) {
    const args = [teamId];
    let sql = `SELECT si.capture_wid FROM team_instances ti JOIN sentinela_instances si ON si.id = ti.instance_id
               WHERE ti.team_id = ? AND si.capture_wid IS NOT NULL${tenantSql(actor)}`;
    if (actor.role !== 'superadmin') args.push(actor.tenant_id);
    const [rows] = await pool.query(sql, args); return rows.map((r) => r.capture_wid);
  }
  async function widsForUser(actor, userId) {
    const args = [userId];
    let sql = `SELECT si.capture_wid FROM user_instances ui JOIN sentinela_instances si ON si.id = ui.instance_id
               WHERE ui.user_id = ? AND si.capture_wid IS NOT NULL${tenantSql(actor)}`;
    if (actor.role !== 'superadmin') args.push(actor.tenant_id);
    const [rows] = await pool.query(sql, args); return rows.map((r) => r.capture_wid);
  }

  // Escopo de wids: visibilidade RBAC ∩ (instance_id ∩ team_id ∩ user_id), quando informados.
  async function resolveWidScope(actor, q) {
    let widScope = await visibleCaptureWids(pool, actor); // 'ALL' | string[]
    const restrictions = [];
    if (q.instance_id) restrictions.push(await widsForInstance(actor, q.instance_id));
    if (q.team_id) restrictions.push(await widsForTeam(actor, q.team_id));
    if (q.user_id) restrictions.push(await widsForUser(actor, q.user_id));

    let restricted = null;
    for (const r of restrictions) restricted = restricted === null ? r : restricted.filter((w) => r.includes(w));
    if (restricted !== null) {
      widScope = widScope === 'ALL' ? restricted : widScope.filter((w) => restricted.includes(w));
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
      const identified = parseBool(req.query.identified);
      if (Number.isNaN(identified)) return res.status(400).json({ error: 'identified inválido (use 0 ou 1)' });
      const dFrom = parseDateBound(req.query.date_from, false);
      const dTo = parseDateBound(req.query.date_to, true);
      const derr = dateBoundError(dFrom) || dateBoundError(dTo);
      if (derr) return res.status(400).json({ error: derr });
      const search = (req.query.search || '').trim();
      const lastType = (req.query.type || '').trim();
      const keyword = (req.query.keyword || '').trim();

      const { widScope, empty } = await resolveWidScope(req.actor, req.query);
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
      if (lastType) { outWhere.push('msg.type = ?'); outArgs.push(lastType); } // tipo da ÚLTIMA mensagem
      // Filtro por status de identificação do contato resolvido da conversa (Fase 4).
      if (identified === 1) outWhere.push('ct.identification_source IS NOT NULL');
      else if (identified === 0) outWhere.push('(ct.id IS NULL OR ct.identification_source IS NULL)');
      if (dFrom) { outWhere.push(`msg.last_ts ${dFrom.op} ?`); outArgs.push(dFrom.value); }
      if (dTo) { outWhere.push(`msg.last_ts ${dTo.op} ?`); outArgs.push(dTo.value); }
      if (keyword) {
        // Conversas que CONTÊM alguma mensagem casando a palavra-chave (FULLTEXT/LIKE),
        // RESTRITA ao mesmo escopo de captura visível da listagem (tenant + widScope, que já é
        // RBAC ∩ instance_id ∩ team_id ∩ user_id). Sem isso, um match numa instância NÃO
        // autorizada do mesmo chat vazaria a conversa para gestor/usuário.
        const ks = messageTextSearch('mk.text', keyword);
        let exists = 'EXISTS (SELECT 1 FROM messages mk WHERE mk.tenant_id = msg.tenant_id AND mk.chat_id = msg.chat_id';
        if (widScope !== 'ALL') { exists += ` AND mk.wid IN (${widScope.map(() => '?').join(',')})`; outArgs.push(...widScope); }
        exists += ` AND ${ks.sql})`;
        outWhere.push(exists);
        outArgs.push(...ks.params);
      }
      const outClause = outWhere.join(' AND ');

      const joins = `
        FROM msg
        JOIN chats c ON c.tenant_id = msg.tenant_id AND c.id = msg.chat_id
        LEFT JOIN contact_pick cp ON cp.tenant_id = msg.tenant_id AND cp.chat_id = msg.chat_id
        LEFT JOIN contacts ct ON ct.tenant_id = msg.tenant_id AND ct.id = cp.contact_id
        LEFT JOIN contact_types cty ON cty.tenant_id = ct.tenant_id AND cty.id = ct.contact_type_id
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
                ct.display_name AS contact_display_name, ct.identification_source AS contact_ident_src,
                ct.contact_type_id AS contact_type_id, cty.name AS contact_type_name, cty.color AS contact_type_color,
                si.id AS instance_id, si.name AS instance_name
         ${joins}
         WHERE ${outClause}
         ORDER BY msg.last_ts DESC, msg.tenant_id, msg.chat_id
         LIMIT ? OFFSET ?`,
        [...cteArgs, ...cteArgs, ...outArgs, limit, offset]);

      const chats = rows.map((r) => ({
        id: r.chat_id,
        ref: encodeRef(Number(r.tenant_id), r.chat_id), // usar no detalhe (sem ambiguidade)
        title: r.title || r.contact_display_name || r.contact_name || null,
        isGroup: Number(r.is_group) === 1,
        contact: {
          id: r.contact_id || null,
          name: r.contact_name || null,
          displayName: r.contact_display_name || null,
          phone: r.contact_phone || null,
          identified: r.contact_ident_src != null,
          type: r.contact_type_id ? { id: r.contact_type_id, name: r.contact_type_name || null, color: r.contact_type_color || null } : null,
        },
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
      const derr = dateBoundError(dFrom) || dateBoundError(dTo);
      if (derr) return res.status(400).json({ error: derr });
      const search = (req.query.search || '').trim();

      const { widScope, empty } = await resolveWidScope(req.actor, req.query);
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

      // Página 1 = as `limit` mensagens MAIS RECENTES; página 2 = as `limit` anteriores, e assim
      // por diante (paginação "para trás" no tempo). Selecionamos em ordem decrescente e revertemos
      // cada página para ordem CRONOLÓGICA (asc) antes de enviar — o frontend faz prepend das
      // páginas mais antigas no topo. Empate de timestamp é desempatado por `id` (mesma chave nos
      // dois sentidos), garantindo páginas sem sobreposição nem buracos.
      const [rows] = await pool.query(
        `SELECT m.id, m.chat_id, m.type, m.text, m.from_me, m.from_internal, m.timestamp,
                m.contact_id, ct.name AS contact_name, ct.phone AS contact_phone,
                ct.display_name AS contact_display_name,
                ct.contact_type_id AS contact_type_id, cty.name AS contact_type_name, cty.color AS contact_type_color
         FROM messages m
         LEFT JOIN contacts ct ON ct.tenant_id = m.tenant_id AND ct.id = m.contact_id
         LEFT JOIN contact_types cty ON cty.tenant_id = m.tenant_id AND cty.id = ct.contact_type_id
         WHERE ${clause}
         ORDER BY m.timestamp DESC, m.id DESC
         LIMIT ? OFFSET ?`,
        [...args, limit, offset]);
      rows.reverse();

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
          : {
            contactId: r.contact_id || null,
            name: r.contact_name || null,
            displayName: r.contact_display_name || null,
            phone: r.contact_phone || null,
            type: r.contact_type_id ? { id: r.contact_type_id, name: r.contact_type_name || null, color: r.contact_type_color || null } : null,
          },
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
