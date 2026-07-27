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

export const FT_MIN_TOKEN = 3; // alinhado ao innodb_ft_min_token_size (default do MySQL)

// Busca textual em mensagens, em CAMINHOS SEPARADOS (nunca MATCH e LIKE simultâneos,
// para não neutralizar o índice FULLTEXT). Retorna { mode, sql, params }:
//  - mode 'none'     → termo vazio: sem cláusula.
//  - mode 'like'     → termo curto (< FT_MIN_TOKEN) OU sem nenhum token compatível com
//                      o boolean mode: apenas `LIKE` (o FULLTEXT ignora tokens curtos).
//  - mode 'fulltext' → termo compatível: apenas `MATCH ... AGAINST (BOOLEAN MODE)` com prefixo *.
//
// Limitações (documentadas em docs/API-CONVERSAS.md):
//  - substring NO MEIO da palavra não é garantida no caminho FULLTEXT (prefixo casa só o início).
//  - stopwords e tamanho mínimo de token dependem da configuração do MySQL (innodb_ft_*).
//  - busca curta cai em `LIKE` (pode ser mais cara: varredura por substring).
// Valores sempre parametrizados (?), sem concatenação de SQL.
export function messageTextSearch(column, term) {
  const raw = (term || '').trim();
  if (!raw) return { mode: 'none', sql: '', params: [] };
  // Remove operadores do boolean mode; sobra apenas o "conteúdo" pesquisável.
  const cleaned = raw.replace(/[+\-><()~*"@]/g, ' ').replace(/\s+/g, ' ').trim();
  const longestToken = cleaned ? cleaned.split(' ').reduce((a, t) => Math.max(a, t.length), 0) : 0;

  // Sem token compatível com FULLTEXT (curto/vazio após limpeza) → LIKE sobre o termo original.
  if (longestToken < FT_MIN_TOKEN) {
    return { mode: 'like', sql: `${column} LIKE ?`, params: [`%${raw}%`] };
  }
  return {
    mode: 'fulltext',
    sql: `MATCH(${column}) AGAINST(? IN BOOLEAN MODE)`,
    params: [`${cleaned}*`],
  };
}
