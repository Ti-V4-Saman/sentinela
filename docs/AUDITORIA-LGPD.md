# Auditoria, Retenção e LGPD (Fase 6)

Registro de acessos/alterações (`access_logs`) + relatórios agregados, com foco em **mínimo
necessário** e **sem conteúdo sensível**.

## Finalidade dos logs
- Segurança e rastreabilidade: quem fez o quê, quando e de onde (IP), em ações relevantes.
- Suporte a investigação de incidentes e conformidade (accountability).
- **Não** é analítico de negócio nem perfilamento de titulares.

## Dados registrados (`access_logs`)
| Campo | Conteúdo |
|---|---|
| `tenant_id` | cliente afetado (NULL para ações globais de superadmin, ex.: login super). |
| `actor_user_id` / `actor_role` | quem executou (NULL em falha de login). |
| `action` / `resource` | **listas fechadas** (server/audit.js) — evita logs inconsistentes. |
| `resource_id` | identificador do recurso (id de contato/tipo/instância, `ref` de chat, tipo de relatório). |
| `status` | `ok` \| `fail`. |
| `ip` | IP do cliente (atrás de proxy: `trust proxy`). |
| `metadata` | JSON apenas com metadados **não sensíveis** (ex.: `{propagated: 3}`, `{mapped: true}`, `{rows, from, to}`). |
| `created_at` | timestamp (horário do banco). |

### Ações auditadas (lista fechada)
`login`, `login_failed`, `view_thread` (abertura/visualização de conversa — só a 1ª página),
`identify_contact`, `clear_identification`, `create_contact_type`, `update_contact_type`,
`delete_contact_type`, `set_capture_wid`, `link_user_instance`, `unlink_user_instance`,
`link_team_instance`, `unlink_team_instance`, `export`.

## Dados deliberadamente NÃO registrados
- **Conteúdo integral de mensagens** (texto/transcrição) — nunca.
- **Tokens** (QuePasa/JWT), **senhas**/`password_hash`, **payloads de autenticação** (nem o e-mail
  tentado em falha de login).
- **`capture_wid` cru** — o evento de mapeamento grava apenas `{mapped: true|false}`.
- Qualquer dado pessoal desnecessário ao propósito de auditoria.

## Política de falha da auditoria
`writeAudit` **nunca** lança nem propaga erro — uma falha ao auditar **não derruba a rota** (nem de
leitura, nem de mutação; a mutação já é a fonte da verdade). Toda falha é **registrada em stderr**
(`console.error`), portanto **não é silenciosa** — recomenda-se monitorar esse log em produção.
Ações fora das listas fechadas são recusadas (logadas em stderr) e **não** gravadas.

## Acesso por papel (RBAC)
- **superadmin**: auditoria e relatórios globais; pode filtrar por `tenant_id`.
- **admin**: auditoria e relatórios **apenas do próprio tenant**.
- **gestor / usuário**: **sem acesso** à auditoria e aos relatórios administrativos.
  - Decisão: o escopo de relatórios para gestor exigiria resolver com segurança as instâncias/equipes
    visíveis sem risco de vazamento entre tenants; para não arriscar, a Fase 6 restringe a admin+super.
    Reavaliar em fase futura com escopo explícito comprovadamente seguro.

## Exportações
- Apenas **CSV** nesta fase (sem dependência externa). XLSX ficou fora (sem biblioteca adequada; evita
  risco/tamanho). PDF fora de escopo (sem valor comprovado nesta fase).
- Escopo por tenant, período obrigatório e **limite de linhas** (50.000).
- **Proteção contra CSV injection**: células iniciadas por `= + - @` (ou TAB/CR) são prefixadas com `'`.
- Encoding **UTF-8 com BOM** + delimitador `;` (Excel pt-BR). Nome de arquivo saneado.
- Toda exportação é **registrada** em `access_logs` (`action=export`), sem conteúdo — só contadores.

## Retenção (recomendação)
- Sugestão: reter `access_logs` por **12 meses** e então expurgar por rotina administrativa aprovada.
- `access_logs.tenant_id` é **FK ON DELETE CASCADE**: excluir um cliente remove seus logs (coerente com
  a exclusão de tenant já cascatear usuários/equipes). `actor_user_id` é **ON DELETE SET NULL** (preserva
  o evento mesmo se o usuário for removido).

## Anonimização e exclusão
- Não há, nesta fase, exclusão massiva automática nem anonimização destrutiva — exigem **nova aprovação**.
- Exclusão pontual/anonimização de titular deve ser tratada por procedimento administrativo (fora do
  escopo automatizado atual).

## Limitações atuais
- Retenção/expurgo automáticos **não implementados** (recomendação documentada; execução manual/aprovada).
- Relatórios/auditoria não disponíveis para gestor (ver decisão de RBAC acima).
- Timezone dos relatórios/logs é o **horário do banco, sem timezone** (mesma convenção da Fase 2).
