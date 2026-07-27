import express from 'express';
import { tenantFilter, visibleInstanceIds } from '../middleware/tenantScope.js';
import { loadActor, isAdmin } from '../middleware/actor.js';

// includeToken controla exposição do token QuePasa (credencial sensível):
// só admin/superadmin e o DONO da instância recebem.
const formatInstance = (row, { includeToken = false } = {}) => ({
  id: row.id,
  tenantId: row.tenant_id,
  ownerUserId: row.owner_user_id,
  name: row.name,
  ...(includeToken ? { token: row.token } : {}),
  status: row.status,
  phoneNumber: row.phone_number || '',
  contactName: row.contact_name || '',
  avatarUrl: row.avatar_url || '',
  webhookUrl: row.webhook_url || '',
  // Ponte de captura (Fase 2): mapeada = conversas de gestor/usuário ficam acessíveis.
  captureWid: row.capture_wid || null,
  captureMapped: !!row.capture_wid,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export function createInstancesRouter(pool) {
  const router = express.Router();

  // GET all (tenant + role scoped). Token só para admin ou dono.
  router.get('/', async (req, res) => {
    try {
      const { sql: tSql, params } = tenantFilter(req.auth);
      const visible = await visibleInstanceIds(pool, req.auth);

      const where = [], args = [];
      if (tSql) { where.push(tSql); args.push(...params); }
      if (visible !== 'ALL') {
        if (visible.length === 0) return res.json([]);
        where.push(`id IN (${visible.map(() => '?').join(',')})`);
        args.push(...visible);
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const [rows] = await pool.query(
        `SELECT * FROM sentinela_instances ${clause} ORDER BY created_at DESC`, args);
      const admin = isAdmin(req.auth.role);
      res.json(rows.map((r) => formatInstance(r, {
        includeToken: admin || Number(r.owner_user_id) === Number(req.auth.userId),
      })));
    } catch (e) {
      console.error('list instances:', e);
      res.status(e.statusCode || 500).json({ error: 'Falha ao listar instâncias' });
    }
  });

  // POST: qualquer usuário autenticado cria a PRÓPRIA instância.
  // owner_user_id = usuário logado; tenant_id = tenant do usuário (mesmo tenant garantido).
  // Superadmin não tem tenant → não pode ser dono de instância.
  router.post('/', async (req, res) => {
    try {
      const actor = await loadActor(pool, req.auth.userId);
      if (!actor || actor.status !== 'active') {
        return res.status(401).json({ error: 'Sessão inválida ou usuário desativado' });
      }
      if (actor.role === 'superadmin' || !actor.tenant_id) {
        return res.status(403).json({ error: 'Superadmin não possui cliente para ser dono de instância' });
      }
      const { id, name, token, status, phoneNumber, contactName, avatarUrl, webhookUrl } = req.body || {};
      if (!id || !name || !token) {
        return res.status(400).json({ error: 'id, name e token são obrigatórios' });
      }
      // Número obrigatório para criar/conectar instância.
      const phoneDigits = String(phoneNumber || '').replace(/\D/g, '');
      if (phoneDigits.length < 10) {
        return res.status(400).json({ error: 'Informe o número de telefone (com DDD e país) da instância' });
      }
      // Não permitir nova instância para um número que já tem instância de um USUÁRIO ATIVO
      // no mesmo cliente — orienta a reconectar a existente. (Instância de usuário desativado
      // não bloqueia: o número foi "aposentado" junto com o usuário.)
      const [existing] = await pool.query(
        `SELECT si.id, si.name, si.phone_number, u.name AS owner_name
         FROM sentinela_instances si JOIN users u ON u.id = si.owner_user_id
         WHERE si.tenant_id = ? AND u.status = 'active'`, [actor.tenant_id]);
      const conflict = existing.find((r) => String(r.phone_number || '').replace(/\D/g, '') === phoneDigits);
      if (conflict) {
        return res.status(409).json({
          error: `Já existe uma instância ativa para esse número (dono: ${conflict.owner_name}). Reconecte a instância "${conflict.name}" em vez de criar uma nova.`,
          existingInstanceId: conflict.id,
          existingInstanceName: conflict.name,
        });
      }

      await pool.query(
        `INSERT INTO sentinela_instances
         (id, tenant_id, owner_user_id, name, token, status, phone_number, contact_name, avatar_url, webhook_url)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [id, actor.tenant_id, actor.id, name, token, status || 'Disconnected',
         phoneDigits, contactName || null, avatarUrl || null, webhookUrl || null]);
      const [rows] = await pool.query('SELECT * FROM sentinela_instances WHERE id = ?', [id]);
      res.status(201).json(formatInstance(rows[0], { includeToken: true }));
    } catch (e) {
      console.error('create instance:', e);
      res.status(500).json({ error: 'Falha ao criar instância' });
    }
  });

  // PUT: o DONO (sua própria) ou admin/superadmin do tenant.
  // Instância fora do escopo → 404 (não revela existência).
  router.put('/:id', async (req, res) => {
    const { id } = req.params;
    try {
      const actor = await loadActor(pool, req.auth.userId);
      if (!actor || actor.status !== 'active') {
        return res.status(401).json({ error: 'Sessão inválida ou usuário desativado' });
      }
      const [rowsOwn] = await pool.query('SELECT tenant_id, owner_user_id FROM sentinela_instances WHERE id = ?', [id]);
      if (rowsOwn.length === 0) return res.status(404).json({ error: 'Instância não encontrada' });
      const inst = rowsOwn[0];
      const sameTenant = Number(inst.tenant_id) === Number(actor.tenant_id);
      const isOwner = Number(inst.owner_user_id) === Number(actor.id);
      const canManage = actor.role === 'superadmin' || (isAdmin(actor.role) && sameTenant) || isOwner;
      if (!canManage) {
        // Não-dono sem privilégio no tenant: 404 para não vazar existência.
        return res.status(sameTenant || actor.role === 'superadmin' ? 403 : 404).json({ error: sameTenant ? 'Sem permissão para alterar esta instância' : 'Instância não encontrada' });
      }

      const map = {
        name: 'name', token: 'token', status: 'status',
        phoneNumber: 'phone_number', contactName: 'contact_name',
        avatarUrl: 'avatar_url', webhookUrl: 'webhook_url',
      };
      const updates = [], values = [];
      for (const [k, col] of Object.entries(map)) {
        if (req.body[k] !== undefined) { updates.push(`${col} = ?`); values.push(req.body[k]); }
      }
      if (updates.length === 0) return res.status(400).json({ error: 'Nada para atualizar' });
      values.push(id);
      await pool.query(`UPDATE sentinela_instances SET ${updates.join(', ')} WHERE id = ?`, values);
      const [rows] = await pool.query('SELECT * FROM sentinela_instances WHERE id = ?', [id]);
      res.json(formatInstance(rows[0], { includeToken: true }));
    } catch (e) {
      console.error('update instance:', e);
      res.status(500).json({ error: 'Falha ao atualizar instância' });
    }
  });

  // PUT /:id/capture-wid — vincula a instância gerenciada à instância de CAPTURA
  // (instances.wid) usada em messages.wid. Fase 2. Restrito a admin/superadmin;
  // NÃO editável pelo frontend comum nem pelo dono. Valida tenant e unicidade global.
  router.put('/:id/capture-wid', async (req, res) => {
    const { id } = req.params;
    try {
      const actor = await loadActor(pool, req.auth.userId);
      if (!actor || actor.status !== 'active') {
        return res.status(401).json({ error: 'Sessão inválida ou usuário desativado' });
      }
      if (!isAdmin(actor.role)) return res.status(403).json({ error: 'Sem permissão' });

      const [rows] = await pool.query('SELECT tenant_id FROM sentinela_instances WHERE id = ?', [id]);
      if (rows.length === 0) return res.status(404).json({ error: 'Instância não encontrada' });
      const inst = rows[0];
      if (actor.role !== 'superadmin' && Number(inst.tenant_id) !== Number(actor.tenant_id)) {
        return res.status(404).json({ error: 'Instância não encontrada' }); // não vaza existência
      }

      const captureWid = req.body?.captureWid ?? null;

      // Limpar a ponte (revoga acesso operacional de gestor/usuário imediatamente).
      if (captureWid === null || captureWid === '') {
        await pool.query('UPDATE sentinela_instances SET capture_wid = NULL WHERE id = ?', [id]);
        return res.json({ id, captureWid: null });
      }
      if (typeof captureWid !== 'string') return res.status(400).json({ error: 'captureWid inválido' });

      // A instância de captura deve existir e pertencer ao MESMO tenant.
      const [cap] = await pool.query('SELECT tenant_id FROM instances WHERE wid = ?', [captureWid]);
      if (cap.length === 0) return res.status(404).json({ error: 'Instância de captura (wid) não encontrada' });
      if (Number(cap[0].tenant_id) !== Number(inst.tenant_id)) {
        return res.status(403).json({ error: 'Instância de captura pertence a outro cliente' });
      }

      try {
        await pool.query('UPDATE sentinela_instances SET capture_wid = ? WHERE id = ?', [captureWid, id]);
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') {
          return res.status(409).json({ error: 'Este wid de captura já está vinculado a outra instância' });
        }
        throw e;
      }
      res.json({ id, captureWid });
    } catch (e) {
      console.error('set capture_wid:', e);
      res.status(500).json({ error: 'Falha ao vincular instância de captura' });
    }
  });

  // GET /:id/capture-candidates — wids de captura (instances.wid) do MESMO tenant ainda
  // não vinculados a OUTRA instância gerenciada. Popula o picker de mapeamento manual.
  router.get('/:id/capture-candidates', async (req, res) => {
    const { id } = req.params;
    try {
      const actor = await loadActor(pool, req.auth.userId);
      if (!actor || actor.status !== 'active') {
        return res.status(401).json({ error: 'Sessão inválida ou usuário desativado' });
      }
      if (!isAdmin(actor.role)) return res.status(403).json({ error: 'Sem permissão' });

      const [rows] = await pool.query('SELECT tenant_id, capture_wid FROM sentinela_instances WHERE id = ?', [id]);
      if (rows.length === 0) return res.status(404).json({ error: 'Instância não encontrada' });
      const inst = rows[0];
      if (actor.role !== 'superadmin' && Number(inst.tenant_id) !== Number(actor.tenant_id)) {
        return res.status(404).json({ error: 'Instância não encontrada' });
      }
      // Só wids do tenant da instância; exclui os já usados por OUTRA instância (mantém o atual).
      const [cands] = await pool.query(
        `SELECT i.wid FROM instances i
         WHERE i.tenant_id = ?
           AND i.wid NOT IN (SELECT capture_wid FROM sentinela_instances WHERE capture_wid IS NOT NULL AND id <> ?)
         ORDER BY i.wid`,
        [inst.tenant_id, id]);
      res.json({ current: inst.capture_wid || null, candidates: cands.map((r) => r.wid) });
    } catch (e) {
      console.error('capture candidates:', e);
      res.status(500).json({ error: 'Falha ao listar candidatos de captura' });
    }
  });

  // Instância NUNCA é excluída (histórico usado em pesquisas/relatórios).
  // Para "remover" alguém, desative o usuário — a instância continua ativa.
  // (Sem rota DELETE por decisão de produto.)

  return router;
}
