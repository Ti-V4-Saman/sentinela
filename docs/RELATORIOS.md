# Relatórios e Dashboard (Fase 6)

Endpoints **agregados** e **tenant-safe** para o painel executivo e a tela de relatórios. **RBAC**:
admin (só o próprio tenant) e superadmin (global ou `tenant_id=`). Gestor/usuário **não** acessam
(ver `docs/AUDITORIA-LGPD.md`). Nunca retornam conteúdo de mensagem.

## Convenções
- **Datas** `from`/`to` no formato `YYYY-MM-DD`, **horário do banco, sem timezone** (Fase 2).
  Intervalo **inclusivo** nos dois extremos; internamente `[from 00:00:00, (to+1dia) 00:00:00)`.
- Validação **semântica** (calendário/bissexto) → inválida = `400`. **Janela máxima 366 dias** → `400`.
- Direção da mensagem: `from_me=1` = **enviada**, `from_me=0` = **recebida**.
- Agregações **no banco** (COUNT/SUM/GROUP BY); listas **paginadas**; **sem N+1**.

## Endpoints — `/api/reports` (GET, `?from&to[&tenant_id]`)
| Rota | Retorno |
|---|---|
| `/summary` | `{ range, messages:{received,sent,total}, conversations, groups, contacts:{total,identified,pending} }`. Mensagens/conversas/grupos são do **período**; contatos são estado **atual**. |
| `/daily` | `{ range, daily:[{date,received,sent,total}] }` — `GROUP BY DATE`. |
| `/by-instance?page&limit` | `{ page,limit,total, items:[{instanceId,name,received,sent,total}] }` — via `messages.wid = sentinela_instances.capture_wid`. |
| `/by-team?page&limit` | `{ ..., items:[{teamId,name,received,sent,total}] }` — via `team_instances → capture_wid → messages.wid`. |
| `/media-types` | `{ range, items:[{type,total}] }` — `GROUP BY type`. |
| `/export?type=&from&to[&tenant_id]` | **CSV** (`type` ∈ `daily|by-instance|by-team|media-types`). |

## Exportação CSV
- `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="relatorio_<type>_<from>_<to>.csv"` (nome saneado).
- **UTF-8 com BOM** + delimitador `;` (Excel pt-BR); **anti-injection** (prefixo `'` em `= + - @`).
- Limite de **50.000 linhas**; toda exportação é **auditada** (`action=export`, só contadores).

## Frontend
- **Painel** (`DashboardView`): KPIs + **linha** (evolução diária, recebidas/enviadas) + **barras**
  (tipos de mídia). Família `charts` (SVG + tokens, sem dependência externa).
- **Relatórios** (`ReportsView`): barras de volume por **instância** e por **equipe** + botões **CSV**
  (evolução diária, por instância, por equipe).
- Controles de **período** (padrão: últimos 30 dias) e, para superadmin, **cliente**. Estados
  loading/vazio/erro. Sem análises de IA.
