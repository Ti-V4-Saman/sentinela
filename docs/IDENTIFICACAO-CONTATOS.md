# Identificação de Contatos (Fase 4)

Permite **nomear**, **categorizar** e **vincular a um usuário** os contatos capturados, com
**autoidentificação por telefone** (propaga a identidade para contatos duplicados). Multi-tenant
+ RBAC. A gestão (tipos, identificação) é restrita a **admin/superadmin**; gestor/usuário apenas
**consomem** a identificação nas conversas (somente leitura).

Identificadores nos exemplos são fictícios.

---

## Modelo de dados

Migration `20260728120000_contact_identification.cjs` (reversível, defensiva). **Não executada em
produção** (exige janela de manutenção aprovada — ALTER/ADD CONSTRAINT).

### `contact_types` (categorias por tenant)
| Coluna | Tipo | Observação |
|---|---|---|
| `id` | BIGINT UNSIGNED AI | PK |
| `tenant_id` | BIGINT UNSIGNED | FK → tenants (ON DELETE CASCADE) |
| `name` | VARCHAR(80) | UNIQUE `(tenant_id, name)` |
| `color` | VARCHAR(24) | tom semântico (= tones do `StatusBadge`): `neutral,info,ia,success,warning,alert,destructive` |

Há também `UNIQUE (tenant_id, id)` — necessário para a **FK composta tenant-safe** a partir de `contacts`.

### `contacts` — novas colunas
| Coluna | Tipo | Observação |
|---|---|---|
| `display_name` | VARCHAR(255) NULL | nome de exibição |
| `contact_type_id` | BIGINT UNSIGNED NULL | **FK composta** `(tenant_id, contact_type_id)` → `contact_types(tenant_id, id)` (ON DELETE RESTRICT). Garante no banco que o tipo é do MESMO tenant. |
| `linked_user_id` | BIGINT UNSIGNED NULL | FK → users(id) ON DELETE SET NULL. Mesmo-tenant validado na aplicação. |
| `identification_source` | ENUM('manual','auto') NULL | NULL = **não identificado**. |
| `identified_by_user_id` | BIGINT UNSIGNED NULL | quem fez a identificação manual (NULL em `auto`). FK → users(id) ON DELETE SET NULL. |
| `identified_at` | TIMESTAMP NULL | quando. |

**Identificado** ⇔ `identification_source IS NOT NULL`. A FK de tipo é `RESTRICT` (inclui `tenant_id`
NOT NULL, não permite SET NULL): a exclusão de um tipo **desvincula** os contatos (`SET contact_type_id=NULL`)
antes de remover.

---

## Regras de identificação

- **Manual** (`PUT /api/contacts/:id/identify`): grava `display_name`/`contact_type_id`/`linked_user_id`
  informados (campos ausentes → NULL — semântica de **substituição** total do estado de identificação),
  `identification_source='manual'`, `identified_by_user_id=ator`, `identified_at=NOW()`. Exige ao menos
  um dos três campos. Tipo/usuário de **outro tenant** → `400` (defesa em profundidade além das FKs).
- **Autoidentificação por telefone**: ao identificar manualmente um contato com telefone `P`, a mesma
  identidade (`display_name`, tipo, usuário) é **propagada** aos OUTROS contatos do mesmo tenant com o
  **mesmo telefone** que **não** estejam identificados manualmente — marcados como `source='auto'`,
  `identified_by=NULL`. Também disponível em lote via `POST /api/contacts/auto-identify`.
- **Proteção da identificação manual**: `auto` **nunca** sobrescreve `source='manual'`. Só preenche
  contatos com `source IS NULL` ou `source='auto'`.
- **Telefones duplicados**: o casamento é por telefone **exato** (string armazenada). Contato sem
  telefone não propaga nem recebe propagação.
- **Limpeza** (`DELETE /api/contacts/:id/identify`): zera os campos deste contato (volta a não
  identificado). Não cascateia para as cópias `auto` (limpeza é por contato, explícita).

---

## Endpoints

### Tipos — `/api/contact-types` (admin/superadmin)
| Método | Rota | Corpo | Notas |
|---|---|---|---|
| GET | `/` | — | Lista do tenant (super: `?tenantId=`), com `contactCount`. |
| POST | `/` | `{name, color?, tenantId?}` | `color` inválido → `400`; nome duplicado no tenant → `409`. super exige `tenantId`. |
| PUT | `/:id` | `{name, color?}` | Escopo por tenant (404 fora do escopo). |
| DELETE | `/:id` | — | Desvincula contatos e remove. |

### Contatos — `/api/contacts` (admin/superadmin)
| Método | Rota | Notas |
|---|---|---|
| GET | `/` | Paginada. Filtros: `search` (nome/exibição/telefone), `status` (`identified`/`unidentified`), `type_id`. super: `?tenantId=`. Resposta inclui `counts {total, identified, unidentified}` (sobre o escopo-base, independem do filtro de status). |
| PUT | `/:id/identify` | `{displayName?, contactTypeId?, linkedUserId?, tenantId?}`. Retorna `{contact, propagated}`. |
| DELETE | `/:id/identify` | Limpa a identificação. |
| POST | `/auto-identify` | `{tenantId?}`. Propaga todas as manuais por telefone. Retorna `{phones, propagated}`. |

`:id` é o `contacts.id` (varchar). Para **superadmin**, um mesmo id pode existir em vários tenants →
informe `tenantId` (senão `400` ambíguo). Para os demais, o tenant do ator resolve.

---

## Integração com Conversas (`/api/chats`)

- O objeto `contact` da listagem e o `sender` da thread ganham `displayName` e `type {id,name,color}`;
  a listagem também traz `contact.identified` e usa o `display_name` como **título** da conversa quando
  presente.
- Novo filtro `GET /api/chats?identified=0|1` — filtra pelas conversas cujo contato resolvido está
  (não) identificado. `identified=0` inclui conversas sem contato resolvido. Valor inválido → `400`.

---

## RBAC e isolamento

- Toda query de tipos/contatos é escopada por `tenant_id`; nenhuma rota retorna dados de outro tenant.
- A FK composta de tipo garante no banco que um contato só referencia tipo do próprio tenant; tipo/
  usuário de outro tenant são recusados na aplicação (`400`).
- Gestão restrita a admin/superadmin (403 para gestor/usuário). A **leitura** da identificação nas
  conversas respeita o RBAC de conversas já existente (Fase 2).

## Limitações conhecidas
- **Escopo da gestão**: identificar/gerenciar tipos é apenas admin/superadmin nesta fase; um fluxo para
  gestor identificar contatos dentro do seu escopo de conversas fica para uma fase futura.
- **Matching de telefone é exato** (sem normalização de DDI/formatação); números gravados de formas
  diferentes não são tratados como o mesmo contato.
- Limpar a identificação manual de origem não reverte as cópias `auto` já propagadas.
