# Drill-down do Superadmin (Fase 5)

Tela de **detalhes de um cliente (tenant)** para inspeção administrativa **somente leitura**:
KPIs + instâncias, conversas, grupos, usuários, equipes, vínculos, situação do `capture_wid` e
contatos (identificados/pendentes). Endpoints **separados e paginados** por tabela — sem "resposta
gigante". Nenhuma migration foi necessária (só leitura sobre o schema existente).

## Acesso (RBAC)

- **superadmin**: abre **qualquer** cliente.
- **admin**: abre **somente o próprio** tenant (as rotas aceitam admin, mas resolvem só o tenant dele).
- **gestor / usuário**: **sem acesso** (`403` via `requireActor`).
- **cross-tenant**: um `:id` de outro tenant (para admin) ou inexistente → **`404`** (indistinguível de
  inexistente; não revela existência). superadmin em tenant inexistente → `404`.
- **Sem dados sensíveis**: as respostas não trazem `token`, `webhook`, `password_hash` nem o
  **`capture_wid` cru** — a situação de captura é exposta como **booleano** (`captureMapped`).

## Endpoints — `/api/clients/:id/*`

`:id` é o `tenants.id`. `requireActor(['admin','superadmin'])` + `router.param('id')` resolve/valida o
tenant (404 fora do escopo) antes de qualquer handler.

| Método | Rota | Retorno |
|---|---|---|
| GET | `/:id/overview` | `{ client, kpis }` — agregado (nº **fixo** de COUNTs; ver N+1). |
| GET | `/:id/instances?page&limit` | `{ page, limit, total, instances:[{id,name,status,phoneNumber,captureMapped,owner:{id,name},teamCount}] }` |
| GET | `/:id/users?page&limit` | `{ ..., users:[{id,name,email,role,status,createdAt}] }` (sem `password_hash`) |
| GET | `/:id/teams?page&limit` | `{ ..., teams:[{id,name,userCount,managerCount,instanceCount}] }` |
| GET | `/:id/contacts?page&limit&status` | `{ ..., contacts:[{id,name,displayName,phone,identified,identificationSource,type}] }`. `status` = `identified` \| `pending`. |

**Conversas / Grupos / threads** reutilizam `GET /api/chats` com o parâmetro **`tenant_id`** (apenas
superadmin; escopa a listagem a um cliente — ignorado para os demais papéis, já restritos ao próprio
tenant). Threads abrem por `ref` (que codifica tenant+chat), como na Fase 3.

### `kpis` (overview)
```json
{
  "instances": { "total": 2, "connected": 1, "captureMapped": 1, "captureUnmapped": 1 },
  "conversations": 1, "groups": 1,
  "users": { "total": 3, "byRole": { "admin": 1, "gestor": 1, "usuario": 1 } },
  "teams": 1,
  "contacts": { "total": 3, "identified": 1, "pending": 2 },
  "messages": 4
}
```
"conversas" e "grupos" contam apenas chats **com mensagens** (mesmo critério da listagem da Fase 3).

## Prevenção de N+1

- Cada endpoint faz um número **fixo** de queries, independente do volume:
  - `overview`: ~6 `COUNT`/`GROUP BY` (instâncias, conversas/grupos, usuários por papel, equipes,
    contatos, mensagens) — nenhum loop por linha na aplicação.
  - tabelas: **1 `COUNT` + 1 `SELECT` paginado** (`LIMIT/OFFSET`). Contagens de vínculos
    (equipes/instâncias) vêm de **subqueries correlacionadas dentro do mesmo `SELECT`** (uma query),
    limitadas ao tamanho da página — nunca N chamadas a partir do código.
- Nada de "buscar lista e depois consultar por item" — o front pagina server-side por endpoint.

## Isolamento por tenant

Toda query é escopada por `tenant_id` (resolvido em `resolveTenant`, que respeita o RBAC). Nenhuma
rota retorna dados de outro tenant. O filtro `tenant_id` de `/api/chats` só é honrado para superadmin;
os demais papéis permanecem restritos pelo `conversationTenantFilter` da Fase 2.

## Tela (frontend)

`ClientDetailView` é aberta a partir de **Clientes** (nome clicável ou ação "Ver detalhes"). Cabeçalho
com nome/status + grade de **KPIs** + **abas**: Instâncias, Conversas, Grupos, Usuários, Equipes,
Contatos. As tabelas paginam server-side (hook `usePaged`); Conversas/Grupos reutilizam
`ConversationsView` com a prop `tenantId` (que escopa e **oculta** os filtros de instância/equipe/
usuário). Somente leitura — nenhuma mutação a partir do drill-down.

## Limitações conhecidas
- O drill-down é **somente leitura**; ações de gestão continuam nas telas próprias (Usuários, Equipes,
  Conexões, Contatos).
- Status de instância reflete o estado atual em `sentinela_instances` (atualizado pelo pipeline/QuePasa),
  não um ping ao vivo.
