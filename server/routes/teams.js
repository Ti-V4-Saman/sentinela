import express from 'express';
import { requireActor } from '../middleware/actor.js';
import { writeAudit, clientIp } from '../audit.js';

const formatTeam = (r) => ({
  id: r.id,
  tenantId: r.tenant_id,
  name: r.name,
  userCount: Number(r.user_count ?? 0),
  managerCount: Number(r.manager_count ?? 0),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function createTeamsRouter(pool) {
  const router = express.Router();
  router.use(requireActor(pool, ['admin', 'superadmin']));

  async function loadTeamInScope(actor, id) {
    const [rows] = await pool.query('SELECT * FROM teams WHERE id = ?', [id]);
    const team = rows[0];
    if (!team) return null;
    if (actor.role !== 'superadmin' && Number(team.tenant_id) !== Number(actor.tenant_id)) return null;
    return team;
  }

  // ---- Teams (com contagens de membros e gestores para a tabela) ----
  router.get('/', async (req, res) => {
    try {
      const where = [], args = [];
      if (req.actor.role !== 'superadmin') { where.push('t.tenant_id = ?'); args.push(req.actor.tenant_id); }
      else if (req.query.tenantId) { where.push('t.tenant_id = ?'); args.push(req.query.tenantId); }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const [rows] = await pool.query(
        `SELECT t.*,
           (SELECT COUNT(*) FROM team_users tu WHERE tu.team_id = t.id) AS user_count,
           (SELECT COUNT(*) FROM team_managers tm WHERE tm.team_id = t.id) AS manager_count
         FROM teams t ${clause} ORDER BY t.created_at DESC`, args);
      res.json(rows.map(formatTeam));
    } catch (e) {
      console.error('list teams:', e);
      res.status(500).json({ error: 'Falha ao listar equipes' });
    }
  });

  router.post('/', async (req, res) => {
    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name é obrigatório' });
    let tenantId;
    if (req.actor.role === 'superadmin') {
      tenantId = req.body.tenantId;
      if (!tenantId) return res.status(400).json({ error: 'tenantId é obrigatório' });
      const [t] = await pool.query('SELECT id FROM tenants WHERE id = ?', [tenantId]);
      if (t.length === 0) return res.status(400).json({ error: 'tenantId inexistente' });
    } else { tenantId = req.actor.tenant_id; }
    try {
      const [r] = await pool.query('INSERT INTO teams (tenant_id, name) VALUES (?, ?)', [tenantId, name.trim()]);
      const [rows] = await pool.query('SELECT * FROM teams WHERE id = ?', [r.insertId]);
      res.status(201).json(formatTeam(rows[0]));
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Já existe equipe com esse nome no tenant' });
      console.error('create team:', e);
      res.status(500).json({ error: 'Falha ao criar equipe' });
    }
  });

  router.put('/:id', async (req, res) => {
    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name é obrigatório' });
    try {
      const team = await loadTeamInScope(req.actor, req.params.id);
      if (!team) return res.status(404).json({ error: 'Equipe não encontrada' });
      await pool.query('UPDATE teams SET name = ? WHERE id = ?', [name.trim(), team.id]);
      const [rows] = await pool.query('SELECT * FROM teams WHERE id = ?', [team.id]);
      res.json(formatTeam(rows[0]));
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Já existe equipe com esse nome no tenant' });
      console.error('update team:', e);
      res.status(500).json({ error: 'Falha ao atualizar equipe' });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const team = await loadTeamInScope(req.actor, req.params.id);
      if (!team) return res.status(404).json({ error: 'Equipe não encontrada' });
      await pool.query('DELETE FROM teams WHERE id = ?', [team.id]); // CASCADE limpa team_users/team_managers
      res.json({ success: true, message: 'Equipe removida' });
    } catch (e) {
      console.error('delete team:', e);
      res.status(500).json({ error: 'Falha ao remover equipe' });
    }
  });

  // ---- team_instances: instâncias vinculadas EXPLICITAMENTE à equipe ----
  // Fonte da verdade da visibilidade de conversas do GESTOR (Fase 2). NÃO deriva das
  // instâncias pessoais dos membros. Membros/gestores são preservados (tabelas distintas).
  router.get('/:id/instances', async (req, res) => {
    try {
      const team = await loadTeamInScope(req.actor, req.params.id);
      if (!team) return res.status(404).json({ error: 'Equipe não encontrada' });
      const [rows] = await pool.query(
        `SELECT si.id, si.name, si.status, si.phone_number, si.owner_user_id, si.capture_wid, u.name AS owner_name
         FROM team_instances ti
         JOIN sentinela_instances si ON si.id = ti.instance_id
         JOIN users u ON u.id = si.owner_user_id
         WHERE ti.team_id = ? ORDER BY si.name`, [team.id]);
      res.json(rows.map((r) => ({
        id: r.id, name: r.name, status: r.status, phoneNumber: r.phone_number || '',
        ownerUserId: r.owner_user_id, ownerName: r.owner_name,
        captureWid: r.capture_wid || null, captureMapped: !!r.capture_wid,
      })));
    } catch (e) {
      console.error('list team instances:', e);
      res.status(500).json({ error: 'Falha ao listar instâncias da equipe' });
    }
  });

  router.post('/:id/instances', async (req, res) => {
    const { instanceId } = req.body || {};
    if (!instanceId) return res.status(400).json({ error: 'instanceId é obrigatório' });
    try {
      const team = await loadTeamInScope(req.actor, req.params.id);
      if (!team) return res.status(404).json({ error: 'Equipe não encontrada' });
      // A instância deve existir e pertencer ao MESMO tenant da equipe (sem cross-tenant).
      const [inst] = await pool.query('SELECT tenant_id FROM sentinela_instances WHERE id = ?', [instanceId]);
      if (inst.length === 0 || Number(inst[0].tenant_id) !== Number(team.tenant_id)) {
        return res.status(404).json({ error: 'Instância não encontrada no cliente da equipe' });
      }
      await pool.query('INSERT INTO team_instances (team_id, instance_id) VALUES (?, ?)', [team.id, instanceId]);
      writeAudit(pool, { tenantId: team.tenant_id, actor: req.actor, action: 'link_team_instance', resource: 'team_instance', resourceId: `${team.id}:${instanceId}`, ip: clientIp(req) });
      res.status(201).json({ success: true, teamId: team.id, instanceId });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Instância já vinculada à equipe' });
      console.error('link team instance:', e);
      res.status(500).json({ error: 'Falha ao vincular instância' });
    }
  });

  router.delete('/:id/instances/:instanceId', async (req, res) => {
    try {
      const team = await loadTeamInScope(req.actor, req.params.id);
      if (!team) return res.status(404).json({ error: 'Equipe não encontrada' });
      const [r] = await pool.query('DELETE FROM team_instances WHERE team_id = ? AND instance_id = ?',
        [team.id, req.params.instanceId]);
      if (r.affectedRows === 0) return res.status(404).json({ error: 'Vínculo não encontrado' });
      writeAudit(pool, { tenantId: team.tenant_id, actor: req.actor, action: 'unlink_team_instance', resource: 'team_instance', resourceId: `${team.id}:${req.params.instanceId}`, ip: clientIp(req) });
      res.json({ success: true, message: 'Instância desvinculada' });
    } catch (e) {
      console.error('unlink team instance:', e);
      res.status(500).json({ error: 'Falha ao desvincular instância' });
    }
  });

  // ---- team_users: usuários-membros ----
  router.get('/:id/users', async (req, res) => {
    try {
      const team = await loadTeamInScope(req.actor, req.params.id);
      if (!team) return res.status(404).json({ error: 'Equipe não encontrada' });
      const [rows] = await pool.query(
        `SELECT u.id, u.name, u.email, u.role FROM team_users tu
         JOIN users u ON u.id = tu.user_id WHERE tu.team_id = ? ORDER BY u.name`, [team.id]);
      res.json(rows.map((r) => ({ id: r.id, name: r.name, email: r.email, role: r.role })));
    } catch (e) {
      console.error('list team users:', e);
      res.status(500).json({ error: 'Falha ao listar usuários da equipe' });
    }
  });

  router.post('/:id/users', async (req, res) => {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });
    try {
      const team = await loadTeamInScope(req.actor, req.params.id);
      if (!team) return res.status(404).json({ error: 'Equipe não encontrada' });
      const [urows] = await pool.query('SELECT id, role FROM users WHERE id = ? AND tenant_id = ?', [userId, team.tenant_id]);
      if (urows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado no cliente da equipe' });
      if (urows[0].role !== 'usuario') return res.status(400).json({ error: 'Só usuários com papel "usuário" podem ser membros' });
      await pool.query('INSERT INTO team_users (team_id, user_id) VALUES (?, ?)', [team.id, userId]);
      res.status(201).json({ success: true, teamId: team.id, userId });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Usuário já é membro da equipe' });
      console.error('link team user:', e);
      res.status(500).json({ error: 'Falha ao vincular usuário' });
    }
  });

  router.delete('/:id/users/:userId', async (req, res) => {
    try {
      const team = await loadTeamInScope(req.actor, req.params.id);
      if (!team) return res.status(404).json({ error: 'Equipe não encontrada' });
      const [r] = await pool.query('DELETE FROM team_users WHERE team_id = ? AND user_id = ?', [team.id, req.params.userId]);
      if (r.affectedRows === 0) return res.status(404).json({ error: 'Vínculo não encontrado' });
      res.json({ success: true, message: 'Usuário desvinculado' });
    } catch (e) {
      console.error('unlink team user:', e);
      res.status(500).json({ error: 'Falha ao desvincular usuário' });
    }
  });

  // ---- team_managers: gestores (inalterado) ----
  router.get('/:id/managers', async (req, res) => {
    try {
      const team = await loadTeamInScope(req.actor, req.params.id);
      if (!team) return res.status(404).json({ error: 'Equipe não encontrada' });
      const [rows] = await pool.query(
        `SELECT u.id, u.name, u.email, u.role FROM team_managers tm
         JOIN users u ON u.id = tm.user_id WHERE tm.team_id = ? ORDER BY u.name`, [team.id]);
      res.json(rows.map((r) => ({ id: r.id, name: r.name, email: r.email, role: r.role })));
    } catch (e) {
      console.error('list team managers:', e);
      res.status(500).json({ error: 'Falha ao listar gestores da equipe' });
    }
  });

  router.post('/:id/managers', async (req, res) => {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });
    try {
      const team = await loadTeamInScope(req.actor, req.params.id);
      if (!team) return res.status(404).json({ error: 'Equipe não encontrada' });
      const [urows] = await pool.query('SELECT id, role FROM users WHERE id = ? AND tenant_id = ?', [userId, team.tenant_id]);
      if (urows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado no cliente da equipe' });
      if (urows[0].role !== 'gestor') return res.status(400).json({ error: 'Usuário precisa ter papel gestor' });
      await pool.query('INSERT INTO team_managers (team_id, user_id) VALUES (?, ?)', [team.id, userId]);
      res.status(201).json({ success: true, teamId: team.id, userId });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Gestor já vinculado à equipe' });
      console.error('link team manager:', e);
      res.status(500).json({ error: 'Falha ao vincular gestor' });
    }
  });

  router.delete('/:id/managers/:userId', async (req, res) => {
    try {
      const team = await loadTeamInScope(req.actor, req.params.id);
      if (!team) return res.status(404).json({ error: 'Equipe não encontrada' });
      const [r] = await pool.query('DELETE FROM team_managers WHERE team_id = ? AND user_id = ?', [team.id, req.params.userId]);
      if (r.affectedRows === 0) return res.status(404).json({ error: 'Vínculo não encontrado' });
      res.json({ success: true, message: 'Gestor desvinculado' });
    } catch (e) {
      console.error('unlink team manager:', e);
      res.status(500).json({ error: 'Falha ao desvincular gestor' });
    }
  });

  return router;
}
