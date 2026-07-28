// Auditoria (Fase 6). Grava eventos em access_logs SEM conteúdo sensível.
//
// Política de falha (documentada em docs/AUDITORIA-LGPD.md):
//   `writeAudit` NUNCA lança nem propaga erro — uma falha ao auditar não pode derrubar a rota
//   (nem leitura, nem mutação: a mutação já é a fonte da verdade). Toda falha é registrada em
//   stderr (console.error) — não é escondida silenciosamente; recomenda-se monitorar esse log.

// Listas FECHADAS: qualquer ação/recurso fora daqui é recusado (loga o desvio e não grava),
// evitando logs inconsistentes.
export const AUDIT_ACTIONS = new Set([
  'login', 'login_failed',
  'view_thread',
  'identify_contact', 'clear_identification',
  'create_contact_type', 'update_contact_type', 'delete_contact_type',
  'set_capture_wid',
  'link_user_instance', 'unlink_user_instance',
  'link_team_instance', 'unlink_team_instance',
  'export',
  'create_integration', 'update_integration', 'toggle_integration', 'regenerate_integration_secret',
  'test_integration', 'resend_integration_batch', 'run_integration_batch', 'deliver_integration',
]);
export const AUDIT_RESOURCES = new Set([
  'auth', 'chat', 'contact', 'contact_type', 'instance', 'user_instance', 'team_instance', 'report',
  'integration', 'integration_batch',
]);

// IP do cliente (atrás de proxy: trust proxy já resolve req.ip). Trunca defensivamente.
export function clientIp(req) {
  const ip = (req && (req.ip || req.socket?.remoteAddress)) || null;
  return ip ? String(ip).slice(0, 45) : null;
}

// Grava um evento. `metadata` deve conter apenas dados NÃO sensíveis (contadores, flags).
export async function writeAudit(pool, {
  tenantId = null, actor = null, action, resource, resourceId = null, status = 'ok', ip = null, metadata = null,
}) {
  if (!AUDIT_ACTIONS.has(action) || !AUDIT_RESOURCES.has(resource)) {
    console.error(`audit: ação/recurso fora da lista fechada (action=${action}, resource=${resource}) — não gravado`);
    return;
  }
  try {
    await pool.query(
      `INSERT INTO access_logs (tenant_id, actor_user_id, actor_role, action, resource, resource_id, status, ip, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tenantId ?? (actor ? actor.tenant_id ?? null : null),
        actor ? actor.id ?? actor.userId ?? null : null,
        actor ? actor.role ?? null : null,
        action, resource,
        resourceId != null ? String(resourceId).slice(0, 64) : null,
        status,
        ip,
        metadata != null ? JSON.stringify(metadata) : null,
      ],
    );
  } catch (e) {
    // Nunca derruba a rota; nunca silencioso.
    console.error('audit write failed:', action, resource, e.message);
  }
}
