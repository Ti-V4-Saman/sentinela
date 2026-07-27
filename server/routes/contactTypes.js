import express from 'express';
import { requireActor } from '../middleware/actor.js';
import { withTransaction } from '../tx.js';

// Tons semânticos permitidos = tones do StatusBadge (mapeados a tokens no front, nunca cor hardcoded).
export const VALID_COLORS = ['neutral', 'info', 'ia', 'success', 'warning', 'alert', 'destructive'];

const formatType = (r) => ({
  id: r.id,
  tenantId: r.tenant_id,
  name: r.name,
  color: r.color,
  contactCount: Number(r.contact_count ?? 0),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function createContactTypesRouter(pool) {
  const router = express.Router();
  router.use(requireActor(pool, ['admin', 'superadmin']));

  async function typeInScope(actor, id) {
    const [rows] = await pool.query('SELECT * FROM contact_types WHERE id = ?', [id]);
    const t = rows[0];
    if (!t) return null;
    if (actor.role !== 'superadmin' && Number(t.tenant_id) !== Number(actor.tenant_id)) return null;
    return t;
  }

  // Resolve o tenant-alvo de uma criação. Non-super: sempre o próprio. Super: exige tenantId válido.
  async function resolveTargetTenant(actor, body) {
    if (actor.role !== 'superadmin') return { tenantId: actor.tenant_id };
    const tenantId = body?.tenantId;
    if (!tenantId) return { error: 'tenantId é obrigatório' };
    const [t] = await pool.query('SELECT id FROM tenants WHERE id = ?', [tenantId]);
    if (t.length === 0) return { error: 'tenantId inexistente' };
    return { tenantId };
  }

  function validColor(color) {
    if (color === undefined || color === null || color === '') return { color: 'neutral' };
    if (!VALID_COLORS.includes(color)) return { error: `color inválido (use um de: ${VALID_COLORS.join(', ')})` };
    return { color };
  }

  // GET / — tipos do tenant, com contagem de contatos por tipo.
  router.get('/', async (req, res) => {
    try {
      const where = [], args = [];
      if (req.actor.role !== 'superadmin') { where.push('ct.tenant_id = ?'); args.push(req.actor.tenant_id); }
      else if (req.query.tenantId) { where.push('ct.tenant_id = ?'); args.push(req.query.tenantId); }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const [rows] = await pool.query(
        `SELECT ct.*,
           (SELECT COUNT(*) FROM contacts c WHERE c.tenant_id = ct.tenant_id AND c.contact_type_id = ct.id) AS contact_count
         FROM contact_types ct ${clause} ORDER BY ct.name`, args);
      res.json(rows.map(formatType));
    } catch (e) {
      console.error('list contact types:', e);
      res.status(500).json({ error: 'Falha ao listar tipos de contato' });
    }
  });

  router.post('/', async (req, res) => {
    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name é obrigatório' });
    const col = validColor(req.body?.color);
    if (col.error) return res.status(400).json({ error: col.error });
    const tgt = await resolveTargetTenant(req.actor, req.body);
    if (tgt.error) return res.status(400).json({ error: tgt.error });
    try {
      const [r] = await pool.query(
        'INSERT INTO contact_types (tenant_id, name, color) VALUES (?, ?, ?)', [tgt.tenantId, name.trim(), col.color]);
      const [rows] = await pool.query('SELECT * FROM contact_types WHERE id = ?', [r.insertId]);
      res.status(201).json(formatType(rows[0]));
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Já existe um tipo com esse nome no cliente' });
      console.error('create contact type:', e);
      res.status(500).json({ error: 'Falha ao criar tipo de contato' });
    }
  });

  router.put('/:id', async (req, res) => {
    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name é obrigatório' });
    const col = validColor(req.body?.color);
    if (col.error) return res.status(400).json({ error: col.error });
    try {
      const t = await typeInScope(req.actor, req.params.id);
      if (!t) return res.status(404).json({ error: 'Tipo não encontrado' });
      await pool.query('UPDATE contact_types SET name = ?, color = ? WHERE id = ?', [name.trim(), col.color, t.id]);
      const [rows] = await pool.query('SELECT * FROM contact_types WHERE id = ?', [t.id]);
      res.json(formatType(rows[0]));
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Já existe um tipo com esse nome no cliente' });
      console.error('update contact type:', e);
      res.status(500).json({ error: 'Falha ao atualizar tipo de contato' });
    }
  });

  // DELETE — desvincula os contatos (SET contact_type_id=NULL) e remove o tipo, ATOMICAMENTE.
  // A FK é RESTRICT (inclui tenant_id NOT NULL, não permite SET NULL automático): o desvínculo e a
  // exclusão precisam acontecer na mesma transação (uma falha no DELETE não pode deixar os contatos
  // já desvinculados). Só toca contatos do MESMO tenant do tipo.
  router.delete('/:id', async (req, res) => {
    try {
      const out = await withTransaction(pool, async (conn) => {
        const [rows] = await conn.query('SELECT * FROM contact_types WHERE id = ? FOR UPDATE', [req.params.id]);
        const t = rows[0];
        if (!t || (req.actor.role !== 'superadmin' && Number(t.tenant_id) !== Number(req.actor.tenant_id))) {
          return { status: 404 };
        }
        await conn.query('UPDATE contacts SET contact_type_id = NULL WHERE tenant_id = ? AND contact_type_id = ?', [t.tenant_id, t.id]);
        await conn.query('DELETE FROM contact_types WHERE id = ?', [t.id]);
        return { status: 200 };
      });
      if (out.status === 404) return res.status(404).json({ error: 'Tipo não encontrado' });
      res.json({ success: true, message: 'Tipo removido' });
    } catch (e) {
      console.error('delete contact type:', e);
      res.status(500).json({ error: 'Falha ao remover tipo de contato' });
    }
  });

  return router;
}
