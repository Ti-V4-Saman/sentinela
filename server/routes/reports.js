import express from 'express';
import { requireActor } from '../middleware/actor.js';
import { parseReportRange } from '../reportRange.js';
import { toCsv, safeFilename } from '../csv.js';
import { writeAudit, clientIp } from '../audit.js';

// Relatórios/dashboard agregados (Fase 6). RBAC: admin (só o próprio tenant) e superadmin (global ou
// filtrando por tenant_id). Gestor/usuário NÃO acessam (decisão documentada em docs/RELATORIOS.md).
// Timezone: horário do banco, SEM timezone (mesma convenção da Fase 2). Nunca retorna conteúdo de msg.

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const MAX_EXPORT_ROWS = 50000;

function parsePaging(q) {
  let limit = parseInt(q.limit, 10);
  if (Number.isNaN(limit) || limit < 1) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;
  let page = parseInt(q.page, 10);
  if (Number.isNaN(page) || page < 1) page = 1;
  return { page, limit, offset: (page - 1) * limit };
}

export function createReportsRouter(pool) {
  const router = express.Router();
  router.use(requireActor(pool, ['admin', 'superadmin']));

  // Escopo de tenant para a tabela messages (alias m.). admin: forçado ao próprio; super: opcional.
  function tenantScope(actor, q, alias = 'm.') {
    if (actor.role !== 'superadmin') return { sql: `${alias}tenant_id = ?`, args: [actor.tenant_id] };
    if (q.tenant_id) return { sql: `${alias}tenant_id = ?`, args: [q.tenant_id] };
    return { sql: '', args: [] };
  }

  // WHERE de mensagens: intervalo (obrigatório) + tenant. Retorna { where, args } ou { error }.
  function messageWhere(actor, q) {
    const range = parseReportRange(q);
    if (range.error) return { error: range.error };
    const ts = tenantScope(actor, q);
    const parts = ['m.timestamp >= ?', 'm.timestamp < ?'];
    const args = [range.fromSql, range.toExclusiveSql];
    if (ts.sql) { parts.push(ts.sql); args.push(...ts.args); }
    return { where: parts.join(' AND '), args, range };
  }

  // ---- Resumo (KPIs do período) ----
  router.get('/summary', async (req, res) => {
    try {
      const mw = messageWhere(req.actor, req.query);
      if (mw.error) return res.status(400).json({ error: mw.error });
      const [[msg]] = await pool.query(
        `SELECT SUM(m.from_me = 0) received, SUM(m.from_me = 1) sent, COUNT(*) total FROM messages m WHERE ${mw.where}`, mw.args);
      const [convRows] = await pool.query(
        `SELECT c.is_group g, COUNT(DISTINCT m.chat_id) n
         FROM messages m JOIN chats c ON c.tenant_id = m.tenant_id AND c.id = m.chat_id
         WHERE ${mw.where} GROUP BY c.is_group`, mw.args);
      const conversations = Number(convRows.find((r) => Number(r.g) === 0)?.n || 0);
      const groups = Number(convRows.find((r) => Number(r.g) === 1)?.n || 0);
      // Contatos são estado ATUAL (não do período). Mesmo escopo de tenant.
      const cScope = tenantScope(req.actor, req.query, 'c.');
      const cClause = cScope.sql ? `WHERE ${cScope.sql}` : '';
      const [[contacts]] = await pool.query(
        `SELECT COUNT(*) total, SUM(c.identification_source IS NOT NULL) identified FROM contacts c ${cClause}`, cScope.args);
      const total = Number(contacts.total); const identified = Number(contacts.identified || 0);
      res.json({
        range: { from: req.query.from, to: req.query.to, days: mw.range.days },
        messages: { received: Number(msg.received || 0), sent: Number(msg.sent || 0), total: Number(msg.total || 0) },
        conversations, groups,
        contacts: { total, identified, pending: total - identified },
      });
    } catch (e) {
      console.error('report summary:', e);
      res.status(500).json({ error: 'Falha ao gerar o resumo' });
    }
  });

  // ---- Evolução diária ----
  router.get('/daily', async (req, res) => {
    try {
      const mw = messageWhere(req.actor, req.query);
      if (mw.error) return res.status(400).json({ error: mw.error });
      const [rows] = await pool.query(
        `SELECT DATE_FORMAT(m.timestamp, '%Y-%m-%d') d, SUM(m.from_me = 0) received, SUM(m.from_me = 1) sent, COUNT(*) total
         FROM messages m WHERE ${mw.where} GROUP BY DATE_FORMAT(m.timestamp, '%Y-%m-%d') ORDER BY d`, mw.args);
      res.json({ range: { from: req.query.from, to: req.query.to, days: mw.range.days },
        daily: rows.map((r) => ({ date: r.d, received: Number(r.received || 0), sent: Number(r.sent || 0), total: Number(r.total) })) });
    } catch (e) {
      console.error('report daily:', e);
      res.status(500).json({ error: 'Falha ao gerar a evolução diária' });
    }
  });

  // ---- Volume por instância (paginado) ----
  router.get('/by-instance', async (req, res) => {
    try {
      const mw = messageWhere(req.actor, req.query);
      if (mw.error) return res.status(400).json({ error: mw.error });
      const { page, limit, offset } = parsePaging(req.query);
      const [[cnt]] = await pool.query(
        `SELECT COUNT(*) total FROM (
           SELECT 1 FROM messages m JOIN sentinela_instances si ON si.capture_wid = m.wid
           WHERE ${mw.where} GROUP BY si.id) z`, mw.args);
      const [rows] = await pool.query(
        `SELECT si.id, si.name, COUNT(*) total, SUM(m.from_me = 0) received, SUM(m.from_me = 1) sent
         FROM messages m JOIN sentinela_instances si ON si.capture_wid = m.wid
         WHERE ${mw.where} GROUP BY si.id, si.name ORDER BY total DESC, si.name LIMIT ? OFFSET ?`, [...mw.args, limit, offset]);
      res.json({ page, limit, total: Number(cnt.total),
        items: rows.map((r) => ({ instanceId: r.id, name: r.name, received: Number(r.received || 0), sent: Number(r.sent || 0), total: Number(r.total) })) });
    } catch (e) {
      console.error('report by-instance:', e);
      res.status(500).json({ error: 'Falha ao gerar volume por instância' });
    }
  });

  // ---- Volume por equipe (paginado) ----
  router.get('/by-team', async (req, res) => {
    try {
      const mw = messageWhere(req.actor, req.query);
      if (mw.error) return res.status(400).json({ error: mw.error });
      const { page, limit, offset } = parsePaging(req.query);
      const joins = `FROM messages m
        JOIN sentinela_instances si ON si.capture_wid = m.wid
        JOIN team_instances ti ON ti.instance_id = si.id
        JOIN teams t ON t.id = ti.team_id`;
      const [[cnt]] = await pool.query(`SELECT COUNT(*) total FROM (SELECT 1 ${joins} WHERE ${mw.where} GROUP BY t.id) z`, mw.args);
      const [rows] = await pool.query(
        `SELECT t.id, t.name, COUNT(*) total, SUM(m.from_me = 0) received, SUM(m.from_me = 1) sent
         ${joins} WHERE ${mw.where} GROUP BY t.id, t.name ORDER BY total DESC, t.name LIMIT ? OFFSET ?`, [...mw.args, limit, offset]);
      res.json({ page, limit, total: Number(cnt.total),
        items: rows.map((r) => ({ teamId: r.id, name: r.name, received: Number(r.received || 0), sent: Number(r.sent || 0), total: Number(r.total) })) });
    } catch (e) {
      console.error('report by-team:', e);
      res.status(500).json({ error: 'Falha ao gerar volume por equipe' });
    }
  });

  // ---- Tipos de mídia ----
  router.get('/media-types', async (req, res) => {
    try {
      const mw = messageWhere(req.actor, req.query);
      if (mw.error) return res.status(400).json({ error: mw.error });
      const [rows] = await pool.query(
        `SELECT COALESCE(m.type, 'desconhecido') type, COUNT(*) total FROM messages m WHERE ${mw.where} GROUP BY m.type ORDER BY total DESC`, mw.args);
      res.json({ range: { from: req.query.from, to: req.query.to, days: mw.range.days },
        items: rows.map((r) => ({ type: r.type, total: Number(r.total) })) });
    } catch (e) {
      console.error('report media-types:', e);
      res.status(500).json({ error: 'Falha ao gerar tipos de mídia' });
    }
  });

  // ---- Exportação CSV ----
  const EXPORTS = {
    daily: {
      headers: ['Data', 'Recebidas', 'Enviadas', 'Total'],
      sql: (w) => `SELECT DATE_FORMAT(m.timestamp, '%Y-%m-%d') d, SUM(m.from_me=0) received, SUM(m.from_me=1) sent, COUNT(*) total
                   FROM messages m WHERE ${w} GROUP BY DATE_FORMAT(m.timestamp, '%Y-%m-%d') ORDER BY d LIMIT ${MAX_EXPORT_ROWS}`,
      row: (r) => [r.d, Number(r.received || 0), Number(r.sent || 0), Number(r.total)],
    },
    'by-instance': {
      headers: ['Instância', 'Recebidas', 'Enviadas', 'Total'],
      sql: (w) => `SELECT si.name name, SUM(m.from_me=0) received, SUM(m.from_me=1) sent, COUNT(*) total
                   FROM messages m JOIN sentinela_instances si ON si.capture_wid=m.wid
                   WHERE ${w} GROUP BY si.id, si.name ORDER BY total DESC, si.name LIMIT ${MAX_EXPORT_ROWS}`,
      row: (r) => [r.name, Number(r.received || 0), Number(r.sent || 0), Number(r.total)],
    },
    'by-team': {
      headers: ['Equipe', 'Recebidas', 'Enviadas', 'Total'],
      sql: (w) => `SELECT t.name name, SUM(m.from_me=0) received, SUM(m.from_me=1) sent, COUNT(*) total
                   FROM messages m JOIN sentinela_instances si ON si.capture_wid=m.wid
                   JOIN team_instances ti ON ti.instance_id=si.id JOIN teams t ON t.id=ti.team_id
                   WHERE ${w} GROUP BY t.id, t.name ORDER BY total DESC, t.name LIMIT ${MAX_EXPORT_ROWS}`,
      row: (r) => [r.name, Number(r.received || 0), Number(r.sent || 0), Number(r.total)],
    },
    'media-types': {
      headers: ['Tipo', 'Total'],
      sql: (w) => `SELECT COALESCE(m.type,'desconhecido') type, COUNT(*) total FROM messages m WHERE ${w} GROUP BY m.type ORDER BY total DESC LIMIT ${MAX_EXPORT_ROWS}`,
      row: (r) => [r.type, Number(r.total)],
    },
  };

  router.get('/export', async (req, res) => {
    try {
      const type = (req.query.type || '').trim();
      const spec = EXPORTS[type];
      if (!spec) return res.status(400).json({ error: `type inválido (use: ${Object.keys(EXPORTS).join(', ')})` });
      const mw = messageWhere(req.actor, req.query);
      if (mw.error) return res.status(400).json({ error: mw.error });
      const [rows] = await pool.query(spec.sql(mw.where), mw.args);
      const csv = toCsv(spec.headers, rows.map(spec.row));
      const fname = safeFilename(`relatorio_${type}_${req.query.from}_${req.query.to}`) + '.csv';
      writeAudit(pool, {
        tenantId: req.actor.role === 'superadmin' ? (req.query.tenant_id || null) : req.actor.tenant_id,
        actor: req.actor, action: 'export', resource: 'report', resourceId: type, ip: clientIp(req),
        metadata: { rows: rows.length, from: req.query.from, to: req.query.to },
      });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
      res.send(csv);
    } catch (e) {
      console.error('report export:', e);
      res.status(500).json({ error: 'Falha ao exportar' });
    }
  });

  return router;
}
