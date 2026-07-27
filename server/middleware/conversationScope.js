// Visibilidade de CONVERSAS (Fase 2). Fonte da verdade: os vínculos EXPLÍCITOS
// documentados na Fase 1 (README §RBAC) — team_instances (gestor) e user_instances
// (usuário) — mapeados para a instância de captura via sentinela_instances.capture_wid.
//
// ⚠️ Distinção do `visibleInstanceIds` (tenantScope.js), que resolve visibilidade de
// GERENCIAMENTO por propriedade (owner_user_id) e é usado por /api/instances. Aqui a
// regra é a de LEITURA DE CONVERSAS, deliberadamente por vínculo explícito e fail-closed.
//
// Retorno:
//   'ALL'  → superadmin e admin (sem restrição por instância; o filtro de tenant já escopa).
//   string[] de capture_wid → gestor/usuário (subconjunto; pode ser VAZIO = sem acesso).
//
// Fail-closed: instância sem ponte (capture_wid NULL) nunca entra no conjunto; conjunto
// vazio ⇒ nenhuma conversa (nunca cair para "todas as instâncias do tenant").

export async function visibleCaptureWids(pool, actor) {
  if (actor.role === 'superadmin' || actor.role === 'admin') return 'ALL';

  if (actor.role === 'gestor') {
    // Instâncias das EQUIPES que o gestor gerencia (team_managers → team_instances),
    // com ponte de captura. Não deriva das instâncias pessoais dos membros.
    const [rows] = await pool.query(
      `SELECT DISTINCT si.capture_wid
       FROM team_managers tm
       JOIN teams t ON t.id = tm.team_id
       JOIN team_instances ti ON ti.team_id = tm.team_id
       JOIN sentinela_instances si ON si.id = ti.instance_id
       WHERE tm.user_id = ? AND t.tenant_id = ? AND si.capture_wid IS NOT NULL`,
      [actor.id, actor.tenant_id]);
    return rows.map((r) => r.capture_wid);
  }

  // usuário: instâncias explicitamente vinculadas em user_instances, com ponte de captura.
  const [rows] = await pool.query(
    `SELECT si.capture_wid
     FROM user_instances ui
     JOIN sentinela_instances si ON si.id = ui.instance_id
     WHERE ui.user_id = ? AND si.tenant_id = ? AND si.capture_wid IS NOT NULL`,
    [actor.id, actor.tenant_id]);
  return rows.map((r) => r.capture_wid);
}

// Restrição por tenant para conversas. Superadmin → sem cláusula. Alias opcional (ex.: 'm.').
export function conversationTenantFilter(actor, alias = '') {
  if (actor.role === 'superadmin') return { sql: '', params: [] };
  return { sql: `${alias}tenant_id = ?`, params: [actor.tenant_id] };
}

// Busca textual em mensagens. Estratégia:
//  - termo vazio → sem cláusula.
//  - termo curto (< innodb_ft_min_token_size, default 3) ou incompatível com o
//    boolean mode → apenas LIKE (FULLTEXT ignora tokens curtos).
//  - termo compatível → HÍBRIDO `MATCH(...) OR LIKE`: o FULLTEXT (boolean mode,
//    prefixo *) é o caminho rápido/primário; o LIKE garante correção para casos que
//    o FTS não cobre (substring, stopword) e para linhas ainda não commitadas
//    (o índice FTS do InnoDB não enxerga linhas não-commitadas — relevante em testes).
// Valores sempre parametrizados (?), sem concatenação de SQL.
export function messageTextSearch(column, term) {
  const raw = (term || '').trim();
  if (!raw) return { sql: '', params: [] };
  // Remove operadores do boolean mode para não quebrar a sintaxe do MATCH.
  const cleaned = raw.replace(/[+\-><()~*"@]/g, ' ').replace(/\s+/g, ' ').trim();
  const MIN_TOKEN = 3;
  if (cleaned.length < MIN_TOKEN) {
    return { sql: `${column} LIKE ?`, params: [`%${raw}%`] };
  }
  return {
    sql: `(MATCH(${column}) AGAINST(? IN BOOLEAN MODE) OR ${column} LIKE ?)`,
    params: [`${cleaned}*`, `%${cleaned}%`],
  };
}
