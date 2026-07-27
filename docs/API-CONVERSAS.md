# API de Conversas (Fase 2) — leitura de chats e mensagens

Fundação backend, **somente leitura**, para listar conversas e mensagens capturadas
(pipeline QuePasa → n8n → MySQL). Multi-tenant + RBAC + paginação obrigatória.

Autenticação: `Authorization: Bearer <JWT>` (via `authenticate`). Escopo recarregado do
banco a cada requisição (`requireActor`) — usuário desativado/rebaixado perde acesso na hora.

Todos os identificadores nos exemplos são **anonimizados/fictícios**.

---

## Modelo de acesso (RBAC de conversas)

A visibilidade de conversas usa os **vínculos explícitos** (modelo documentado na Fase 1),
mapeados para a instância de captura via `sentinela_instances.capture_wid`:

| Papel | Vê |
|---|---|
| **superadmin** | Todas as conversas (todos os tenants). Filtros da rota ainda se aplicam. |
| **admin** | Todas as conversas do próprio tenant. |
| **gestor** | Conversas das instâncias vinculadas às equipes que gerencia (`team_managers` → `team_instances` → `capture_wid`). |
| **usuário** | Conversas das instâncias vinculadas em `user_instances` → `capture_wid`. |

**Fail-closed:** instância sem ponte (`capture_wid` NULL) **não** dá acesso a gestor/usuário.
Nunca há fallback para "todas as instâncias do tenant". Conjunto visível vazio ⇒ lista vazia
(`GET /api/chats`) ou `404` (`GET /api/chats/:id/messages`), indistinguível de inexistente.

> ⚠️ Enquanto `team_instances`/`user_instances` não forem populados e `capture_wid` não for
> gravado pelo pipeline, gestor/usuário veem **zero** conversas (comportamento seguro por design).
> Ver `docs/PIPELINE-CAPTURE-WID.md`.

---

## `GET /api/chats` — listagem paginada de conversas

### Parâmetros (query)
| Param | Tipo | Default | Observação |
|---|---|---|---|
| `page` | int ≥ 1 | 1 | |
| `limit` | int 1–100 | 20 | Acima de 100 é **limitado** a 100. |
| `is_group` | `0`\|`1` | — | Individual (0) ou grupo (1). Inválido → `400`. |
| `search` | string | — | Busca por **nome ou telefone do contato** (`LIKE`). |
| `instance_id` | string | — | `sentinela_instances.id` (instância gerenciada). Traduzido para `capture_wid`. |
| `date_from` / `date_to` | `YYYY-MM-DD` ou datetime ISO | — | Filtra pela **última atividade**. Formato ambíguo/inválido → `400`. |

Paginação e ordenação são feitas **no banco**. Ordenação determinística: última atividade
desc, depois `(tenant_id, chat_id)`.

**Datas** (ver `parseDateBound`). Formatos aceitos, **sempre em horário do banco, SEM timezone**:
- `YYYY-MM-DD`
- `YYYY-MM-DDTHH:mm:ss` (segundos opcionais: `YYYY-MM-DDTHH:mm`)
- `YYYY-MM-DD HH:mm:ss` (espaço no lugar do `T`; segundos opcionais)

Semântica: `YYYY-MM-DD` em `date_from` = início do dia (`>= 00:00:00`); em `date_to` = **dia
inteiro** (limite EXCLUSIVO no dia seguinte, `< dia+1 00:00:00`). Datetime é inclusivo (`>=`/`<=`).

Validação: além do formato, valida **semanticamente** — mês/dia reais (incl. anos bissextos:
`2024-02-29` ok, `2025-02-29`/`2026-02-30` → `400`), hora `00–23`, minuto/segundo `00–59`
(`24:00:00`, `10:60:00`, `10:00:60` → `400`). Valores inválidos retornam **`400`**, nunca erro
do MySQL convertido em `500`. Formatos como `01/07/2026` ou texto livre → `400`.
`date_from > date_to` retorna lista vazia (sem erro).

**Timezone:** valores com `Z` ou offset (ex.: `2026-07-27T23:00:00-03:00`) ou com fração de
segundo são **rejeitados com `400`** — o fuso **não** é descartado silenciosamente. O cliente deve
enviar o horário já no fuso do banco, sem timezone.

**Contato da conversa** (ver `contact_pick`): é o contato da **mensagem não-nula mais recente**
do chat — independente da última mensagem (que pode ser enviada/interna/sem contato). Nunca é
substituído silenciosamente pelo remetente da última mensagem. A busca por nome/telefone usa esse
contato resolvido.

### Resposta `200`
```json
{
  "page": 1,
  "limit": 20,
  "total": 3,
  "chats": [
    {
      "id": "CHAT_ID",
      "ref": "REF_OPACO_PARA_NAVEGACAO",
      "title": "Nome da conversa",
      "isGroup": false,
      "contact": { "id": "CONTACT_ID", "name": "Nome", "phone": "55DDDNNNNNNNN" },
      "instance": { "id": "SENTINELA_INSTANCE_ID", "name": "Nome da instância" },
      "lastMessage": { "text": "última mensagem/transcrição", "type": "text", "direction": "incoming", "at": "2026-07-03T08:00:00.000Z" },
      "messageCount": 12,
      "lastActivityAt": "2026-07-03T08:00:00.000Z"
    }
  ]
}
```
Não retorna `wid`, `tenant_id`, tokens nem payloads internos. **`ref`** é um identificador
opaco (codifica tenant+chat) para abrir o detalhe **sem ambiguidade** — passe-o como `:id`.

### Exemplo
`GET /api/chats?is_group=0&search=Alice&limit=20&page=1&date_from=2026-07-01`

---

## `GET /api/chats/:id/messages` — thread paginada

`:id` aceita o **`ref`** opaco (recomendado, retornado na listagem) **ou** o `chat_id` cru.
Como `chats` tem PK composta `(tenant_id, id)`, um mesmo `chat_id` pode existir em mais de um
tenant: para **superadmin** com `chat_id` cru ambíguo → `400` orientando usar o `ref`. Para os
demais papéis o tenant do ator resolve. O RBAC é sempre revalidado (um `ref` de outro tenant
para não-superadmin → `404`).

### Parâmetros (query)
| Param | Tipo | Default | Observação |
|---|---|---|---|
| `page` | int ≥ 1 | 1 | |
| `limit` | int 1–100 | 20 | Limitado a 100. |
| `type` | string | — | Filtra por tipo (`text`, `audio`, `image`, …) conforme os tipos reais no banco. |
| `search` | string | — | Busca por palavra-chave no **texto/transcrição** (FULLTEXT + fallback LIKE). |
| `date_from` / `date_to` | `YYYY-MM-DD`/datetime ISO | — | Filtra por `timestamp` (mesma semântica de datas da listagem). Inválida → `400`. |
| `instance_id` | string | — | Restringe à instância (opcional). |

O chat é **validado no escopo antes de qualquer query de mensagens**: precisa pertencer ao
tenant e (gestor/usuário) a uma instância visível. Caso contrário → `404` (sem oráculo de
existência entre tenants). Ordenação cronológica: `timestamp ASC, id ASC`.

### Resposta `200`
```json
{
  "chat": { "id": "CHAT_ID", "ref": "REF_OPACO", "title": "Nome", "isGroup": false },
  "page": 1,
  "limit": 20,
  "total": 3,
  "messages": [
    {
      "id": "MSG_ID",
      "chatId": "CHAT_ID",
      "type": "audio",
      "text": "transcrição do áudio",
      "direction": "incoming",
      "fromMe": false,
      "fromInternal": false,
      "sender": { "contactId": "CONTACT_ID", "name": "Nome", "phone": "55DDDNNNNNNNN" },
      "at": "2026-07-01T10:02:00.000Z"
    }
  ]
}
```
- `direction`: `outgoing` (from_me=1) ou `incoming`. Mensagem enviada tem `sender: { "self": true }`.
- `text`: conteúdo ou, para `type='audio'`, a **transcrição** (que já chega pronta do pipeline).
- Não retorna `wid`, `tenant_id` nem metadados internos. O schema atual **não** guarda URL de mídia;
  o `type` indica a natureza (áudio/imagem/etc.).

---

## Erros
| Código | Quando |
|---|---|
| `400` | `is_group`, `date_from`/`date_to` inválidos; `chat_id` cru ambíguo entre tenants (superadmin → use o `ref`). |
| `401` | Token ausente/inválido/expirado; usuário desativado. |
| `404` | Chat inexistente, de outro tenant, ou de instância não visível (indistinguíveis). |
| `500` | Falha interna. |

---

## Estratégia de paginação
Offset/limit no SQL (`LIMIT ? OFFSET ?`), com `limit` máximo de **100**. `total` é calculado
por query `COUNT` equivalente (mesmos filtros). A listagem de chats deriva a última mensagem e
a contagem por chat via window functions (`ROW_NUMBER`/`COUNT`/`MAX` particionados por
`(tenant_id, chat_id)`), aproveitando `idx_msg_tenant_chat` e `idx_timestamp`.

## Estratégia de busca (FULLTEXT) — caminhos separados
`messages.text` tem índice **FULLTEXT** `ft_messages_text` (migration separada).
`GET /api/chats/:id/messages?search=` escolhe **um único caminho** (nunca `MATCH` e `LIKE`
simultâneos, para não neutralizar o índice) — ver `messageTextSearch(...).mode`:
- **`none`** — termo vazio: sem filtro;
- **`like`** — termo curto (< `innodb_ft_min_token_size`, default 3) ou sem token compatível com o
  boolean mode: apenas `LIKE` (pode ser mais caro: varredura por substring);
- **`fulltext`** — termo compatível: apenas `MATCH(text) AGAINST(? IN BOOLEAN MODE)` com prefixo `*`.

Limitações do caminho FULLTEXT:
- **substring no meio da palavra não é garantida** (o prefixo `*` casa só o início do token);
- **stopwords** e **tamanho mínimo de token** dependem da configuração do MySQL (`innodb_ft_*`);
- em testes (transação com rollback), o índice FTS do InnoDB **não enxerga linhas não-commitadas**,
  então o caminho `fulltext` é validado por unit tests de `messageTextSearch` (qual caminho é
  escolhido), e o filtro fim-a-fim é exercitado pelo caminho `like`.

A busca em `GET /api/chats?search=` é por **contato** (nome/telefone) via `LIKE`, não por texto de mensagem.

## Limitações conhecidas
- **Ponte de captura obrigatória** para gestor/usuário: sem `capture_wid`, acesso zero (fail-closed).
- `team_instances`/`user_instances` **têm gestão** (endpoints + telas, bloco integração-capture-wid-vínculos):
  vincule as instâncias à equipe (aba Instâncias no modal de Vínculos) ou ao usuário (ação Instâncias)
  para gestor/usuário enxergarem conversas. O **preenchimento automático de `capture_wid` pelo pipeline**
  segue pendente — enquanto isso, superadmin/admin mapeiam manualmente ("Mapear captura" na Gestão de Conexões).
- **Drift de visibilidade de *management*:** `tenantScope.visibleInstanceIds` (usado por `/api/instances`)
  resolve por propriedade (`owner_user_id`), divergindo do modelo documentado de vínculos explícitos.
  As conversas usam a fonte correta (explícita); a reconciliação do management é pendência (não neste escopo).
- Window functions sobre `messages` escalam com o volume; para grandes volumes, avaliar materialização
  de "última atividade por chat".
- Sem URL de mídia no schema (apenas `type` + `text`/transcrição).
