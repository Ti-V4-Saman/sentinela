import express from 'express';
import { requireActor } from '../middleware/actor.js';
import { withTransaction } from '../tx.js';

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

const formatContact = (r, includeTenant) => ({
  id: r.id,
  ...(includeTenant ? { tenantId: r.tenant_id } : {}),
  name: r.name || null,
  displayName: r.display_name || null,
  phone: r.phone || null,
  identified: r.identification_source != null,
  identificationSource: r.identification_source || null,
  type: r.contact_type_id ? { id: r.contact_type_id, name: r.type_name || null, color: r.type_color || null } : null,
  linkedUser: r.linked_user_id ? { id: r.linked_user_id, name: r.linked_user_name || null } : null,
  identifiedBy: r.identified_by_user_id ? { id: r.identified_by_user_id, name: r.identified_by_name || null } : null,
  identifiedAt: r.identified_at || null,
  messageCount: Number(r.message_count ?? 0),
});

// Chave de IDENTIDADE (normalizada) de uma linha manual — para detectar conflitos por telefone.
const identityKey = (r) => JSON.stringify([r.display_name ?? null, r.contact_type_id ?? null, r.linked_user_id ?? null]);

// Origem determinística de um telefone: mais recente por identified_at, desempatando por id DESC.
// (Só é relevante quando as identidades são consistentes; ainda assim escolhemos de forma estável.)
function pickOrigin(list) {
  return list.slice().sort((a, b) => {
    const ta = a.identified_at ? new Date(a.identified_at).getTime() : 0;
    const tb = b.identified_at ? new Date(b.identified_at).getTime() : 0;
    if (tb !== ta) return tb - ta;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0; // id DESC
  })[0];
}

// Propaga a identidade de um contato (origem) para os OUTROS contatos do mesmo tenant com o MESMO
// telefone que NÃO estejam identificados manualmente. Nunca sobrescreve source='manual'. Nunca
// propaga uma identidade VAZIA (evita criar identificação 'auto' sem conteúdo). Retorna nº de linhas.
async function propagateByPhone(conn, tenantId, phone, origin) {
  if (!phone) return 0;
  if (!origin.display_name && !origin.contact_type_id && !origin.linked_user_id) return 0;
  const [r] = await conn.query(
    `UPDATE contacts
        SET display_name = ?, contact_type_id = ?, linked_user_id = ?,
            identification_source = 'auto', identified_by_user_id = NULL, identified_at = NOW()
      WHERE tenant_id = ? AND phone = ? AND id <> ?
        AND (identification_source IS NULL OR identification_source = 'auto')`,
    [origin.display_name, origin.contact_type_id, origin.linked_user_id, tenantId, phone, origin.id]);
  return r.affectedRows;
}

export function createContactsRouter(pool) {
  const router = express.Router();
  router.use(requireActor(pool, ['admin', 'superadmin']));

  // Non-super: tenant fixo do ator. Super: opcional tenantId (query/body) para desambiguar.
  function tenantScope(actor, hint) {
    if (actor.role !== 'superadmin') return { tenantId: actor.tenant_id, forced: true };
    return { tenantId: hint || null, forced: false };
  }

  // db = conn (transação) ou pool. forUpdate=true → bloqueia a linha (SELECT ... FOR UPDATE).
  async function resolveContact(db, actor, id, hint, forUpdate = false) {
    let sql = 'SELECT * FROM contacts WHERE id = ?'; const args = [id];
    if (actor.role !== 'superadmin') { sql += ' AND tenant_id = ?'; args.push(actor.tenant_id); }
    else if (hint) { sql += ' AND tenant_id = ?'; args.push(hint); }
    if (forUpdate) sql += ' FOR UPDATE';
    const [rows] = await db.query(sql, args);
    if (rows.length > 1) return { ambiguous: true };
    return { contact: rows[0] || null };
  }

  // ---- GET / — listagem paginada + contadores ----
  router.get('/', async (req, res) => {
    try {
      const { page, limit, offset } = parsePaging(req.query);
      const status = (req.query.status || '').trim(); // 'identified' | 'unidentified' | ''
      const search = (req.query.search || '').trim();
      const typeId = (req.query.type_id || '').trim();
      const scope = tenantScope(req.actor, req.query.tenantId);

      const base = [], baseArgs = [];
      if (scope.forced) { base.push('c.tenant_id = ?'); baseArgs.push(scope.tenantId); }
      else if (scope.tenantId) { base.push('c.tenant_id = ?'); baseArgs.push(scope.tenantId); }
      if (search) { base.push('(c.name LIKE ? OR c.display_name LIKE ? OR c.phone LIKE ?)'); baseArgs.push(`%${search}%`, `%${search}%`, `%${search}%`); }
      if (typeId) { base.push('c.contact_type_id = ?'); baseArgs.push(typeId); }
      const baseClause = base.length ? `WHERE ${base.join(' AND ')}` : '';

      // Contadores sobre o escopo-base (independente do filtro de status).
      // "identificado" ⇔ identification_source IS NOT NULL (contrato — ver docs/IDENTIFICACAO-CONTATOS.md).
      const [countRows] = await pool.query(
        `SELECT COUNT(*) AS total,
                SUM(c.identification_source IS NOT NULL) AS identified,
                SUM(c.identification_source IS NULL) AS unidentified
         FROM contacts c ${baseClause}`, baseArgs);
      const counts = {
        total: Number(countRows[0].total),
        identified: Number(countRows[0].identified || 0),
        unidentified: Number(countRows[0].unidentified || 0),
      };

      // Filtro de status aplicado apenas à página.
      const where = [...base], args = [...baseArgs];
      if (status === 'identified') where.push('c.identification_source IS NOT NULL');
      else if (status === 'unidentified') where.push('c.identification_source IS NULL');
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

      const [totRows] = await pool.query(`SELECT COUNT(*) AS total FROM contacts c ${clause}`, args);
      const total = Number(totRows[0].total);

      const [rows] = await pool.query(
        `SELECT c.*,
                cty.name AS type_name, cty.color AS type_color,
                lu.name AS linked_user_name,
                ib.name AS identified_by_name,
                (SELECT COUNT(*) FROM messages m WHERE m.tenant_id = c.tenant_id AND m.contact_id = c.id) AS message_count
         FROM contacts c
         LEFT JOIN contact_types cty ON cty.tenant_id = c.tenant_id AND cty.id = c.contact_type_id
         LEFT JOIN users lu ON lu.id = c.linked_user_id
         LEFT JOIN users ib ON ib.id = c.identified_by_user_id
         ${clause}
         ORDER BY (c.display_name IS NULL AND c.name IS NULL), COALESCE(c.display_name, c.name, c.phone), c.id
         LIMIT ? OFFSET ?`, [...args, limit, offset]);

      const includeTenant = req.actor.role === 'superadmin';
      res.json({ page, limit, total, counts, contacts: rows.map((r) => formatContact(r, includeTenant)) });
    } catch (e) {
      console.error('list contacts:', e);
      res.status(500).json({ error: 'Falha ao listar contatos' });
    }
  });

  // ---- PUT /:id/identify — identificação MANUAL (+ propagação por telefone), ATÔMICA ----
  router.put('/:id/identify', async (req, res) => {
    const body = req.body || {};
    const displayName = (body.displayName ?? '').toString().trim() || null;
    const contactTypeId = body.contactTypeId ?? null;
    const linkedUserId = body.linkedUserId ?? null;
    if (!displayName && !contactTypeId && !linkedUserId) {
      return res.status(400).json({ error: 'Informe ao menos displayName, contactTypeId ou linkedUserId' });
    }
    const hint = body.tenantId || req.query.tenantId;
    try {
      // Tudo (revalidação + update principal + propagação + leitura) numa única transação:
      // uma falha na propagação faz ROLLBACK, sem deixar o contato principal parcialmente alterado.
      const out = await withTransaction(pool, async (conn) => {
        const r = await resolveContact(conn, req.actor, req.params.id, hint, true); // FOR UPDATE
        if (r.ambiguous) return { status: 400, error: 'contact_id ambíguo entre tenants; informe tenantId' };
        if (!r.contact) return { status: 404, error: 'Contato não encontrado' };
        const c = r.contact;

        if (contactTypeId) {
          const [t] = await conn.query('SELECT id FROM contact_types WHERE id = ? AND tenant_id = ?', [contactTypeId, c.tenant_id]);
          if (t.length === 0) return { status: 400, error: 'Tipo de contato inválido para este cliente' };
        }
        if (linkedUserId) {
          const [u] = await conn.query('SELECT id FROM users WHERE id = ? AND tenant_id = ?', [linkedUserId, c.tenant_id]);
          if (u.length === 0) return { status: 400, error: 'Usuário inválido para este cliente' };
        }

        await conn.query(
          `UPDATE contacts SET display_name = ?, contact_type_id = ?, linked_user_id = ?,
                  identification_source = 'manual', identified_by_user_id = ?, identified_at = NOW()
           WHERE tenant_id = ? AND id = ?`,
          [displayName, contactTypeId || null, linkedUserId || null, req.actor.id, c.tenant_id, c.id]);

        // Edição manual: a ação humana escolhe explicitamente a origem → propaga.
        const origin = { id: c.id, display_name: displayName, contact_type_id: contactTypeId || null, linked_user_id: linkedUserId || null };
        const propagated = await propagateByPhone(conn, c.tenant_id, c.phone, origin);

        const [rows] = await conn.query(
          `SELECT c.*, cty.name AS type_name, cty.color AS type_color, lu.name AS linked_user_name, ib.name AS identified_by_name,
                  (SELECT COUNT(*) FROM messages m WHERE m.tenant_id = c.tenant_id AND m.contact_id = c.id) AS message_count
           FROM contacts c
           LEFT JOIN contact_types cty ON cty.tenant_id = c.tenant_id AND cty.id = c.contact_type_id
           LEFT JOIN users lu ON lu.id = c.linked_user_id
           LEFT JOIN users ib ON ib.id = c.identified_by_user_id
           WHERE c.tenant_id = ? AND c.id = ?`, [c.tenant_id, c.id]);
        return { status: 200, contact: formatContact(rows[0], req.actor.role === 'superadmin'), propagated };
      });
      if (out.error) return res.status(out.status).json({ error: out.error });
      res.json({ contact: out.contact, propagated: out.propagated });
    } catch (e) {
      console.error('identify contact:', e);
      res.status(500).json({ error: 'Falha ao identificar o contato' });
    }
  });

  // ---- DELETE /:id/identify — limpa TODOS os campos de identificação deste contato ----
  router.delete('/:id/identify', async (req, res) => {
    try {
      const r = await resolveContact(pool, req.actor, req.params.id, req.body?.tenantId || req.query.tenantId);
      if (r.ambiguous) return res.status(400).json({ error: 'contact_id ambíguo entre tenants; informe tenantId' });
      if (!r.contact) return res.status(404).json({ error: 'Contato não encontrado' });
      const c = r.contact;
      await pool.query(
        `UPDATE contacts SET display_name = NULL, contact_type_id = NULL, linked_user_id = NULL,
                identification_source = NULL, identified_by_user_id = NULL, identified_at = NULL
         WHERE tenant_id = ? AND id = ?`, [c.tenant_id, c.id]);
      res.json({ success: true, message: 'Identificação removida' });
    } catch (e) {
      console.error('clear contact identification:', e);
      res.status(500).json({ error: 'Falha ao remover a identificação' });
    }
  });

  // ---- POST /auto-identify — propaga as identificações manuais por telefone (lote), ATÔMICO ----
  // Regra de conflito: se um telefone tem MAIS DE UMA identidade manual DIVERGENTE (display_name,
  // contact_type_id ou linked_user_id diferentes), o telefone é AMBÍGUO — não propaga e conta como
  // conflito. O lote nunca escolhe silenciosamente entre identidades manuais divergentes.
  router.post('/auto-identify', async (req, res) => {
    try {
      const scope = tenantScope(req.actor, req.body?.tenantId || req.query.tenantId);
      if (!scope.forced && !scope.tenantId) return res.status(400).json({ error: 'tenantId é obrigatório' });
      const tenantId = scope.tenantId;
      const result = await withTransaction(pool, async (conn) => {
        const [rows] = await conn.query(
          `SELECT id, phone, display_name, contact_type_id, linked_user_id, identified_at
           FROM contacts
           WHERE tenant_id = ? AND identification_source = 'manual' AND phone IS NOT NULL
           ORDER BY phone, identified_at DESC, id DESC`, [tenantId]);
        const groups = new Map();
        for (const r of rows) {
          if (!groups.has(r.phone)) groups.set(r.phone, []);
          groups.get(r.phone).push(r);
        }
        let propagated = 0, conflicts = 0;
        for (const [phone, list] of groups) {
          const distinct = new Set(list.map(identityKey));
          if (distinct.size > 1) { conflicts += 1; continue; } // identidades manuais divergentes → ambíguo
          propagated += await propagateByPhone(conn, tenantId, phone, pickOrigin(list));
        }
        return { phones: groups.size, propagated, conflicts };
      });
      // Resposta só com contadores — sem expor dados sensíveis dos contatos.
      res.json({ success: true, ...result });
    } catch (e) {
      console.error('auto-identify:', e);
      res.status(500).json({ error: 'Falha na autoidentificação' });
    }
  });

  return router;
}

export const _internals = { propagateByPhone, identityKey, pickOrigin };
