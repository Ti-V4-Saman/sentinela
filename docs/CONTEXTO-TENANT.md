# Contexto global de cliente (tenant) — Etapa A

Permite ao **superadmin** trabalhar em dois contextos: **Visão global** (consolidado, sem caixa
operacional de um tenant) e **Modo cliente** (todas as telas operacionais atuam num tenant escolhido,
aproximando a experiência de um admin daquele cliente — **sem** alterar o papel real).

## Estado global (`src/context/TenantContext.tsx` + `tenantController.ts`)
Contexto central consumido via `useTenant()`; evita cada tela interpretar a URL isoladamente.
```
{ isSuper, activeTenant: {id,name,status}|null, isGlobalView,
  loading, selecting, error, epoch, selectTenant(id): Promise<bool>, exitClient() }
```
- **Visão global**: `activeTenant = null`, `isGlobalView = true` (só superadmin).
- **Modo cliente**: `activeTenant` definido; `isGlobalView = false`.
- Para **não-superadmin** o contexto é inerte (sem seletor, sem tarja) — o backend já os restringe ao
  próprio tenant pelo JWT.
- `loading` = restauração inicial pela URL; `selecting` = troca manual em andamento (o seletor mostra
  spinner mas permite nova escolha — a última prevalece).

## Proteção contra corrida na troca de tenant (`tenantController.ts`)
A lógica de seleção vive num **controller PURO** (sem React/DOM), testável em node
(`test/tenant-controller.test.js`, 8 casos). Garante que **somente a seleção mais recente atualize**
`activeTenant`/URL/`epoch`/loading/erro:
- **contador sequencial**: cada `select`/`init` recebe um token; o resultado só é aplicado se
  `token === seq` (o mais recente). Uma resposta atrasada de uma seleção antiga é **ignorada**.
- **AbortController**: a requisição anterior é **abortada** ao iniciar nova seleção, ao **sair** do
  modo cliente e no **dispose** (desmontagem do provider).
- `exitClient()` incrementa o `seq` (invalida pendentes) e aborta — uma resposta antiga **não reativa**
  o tenant após a saída.
Cenário resolvido: seleciona Alpha, depois Beta; se Alpha responder por último, **Beta prevalece**.

## Persistência na URL (consistência URL ↔ estado)
- A URL reflete **apenas o cliente ativo comitado** (`?tenant=<id>`, `history.replaceState` — reload-safe).
  Assim URL e estado nunca divergem: a URL só muda quando `activeTenant` muda (após validação/saída).
- No carregamento (`loading`) o parâmetro **não é tocado** — evita apagar o `?tenant` que está sendo
  validado. Só após a validação a URL é sincronizada.
- Garantias: **sucesso** → estado e URL no mesmo tenant; **falha** → não grava tenant não validado
  (URL inalterada); **saída durante request** → sem `tenant` e contexto global; **reload válido** →
  restaura; **reload inválido** → limpa o parâmetro; **não-superadmin** → parâmetro removido, escopo
  inalterado.
- Usa sempre `tenant_id` (numérico), nunca o nome como identificador.

## Revalidação e segurança (não confiar só no frontend)
- `selectTenant` chama `GET /api/clients/:id` (novo endpoint): superadmin → qualquer; admin → só o
  próprio; gestor/usuário → `403`; cross-tenant/inexistente → **`404`** (não revela existência).
- **Admin não escapa pela URL**: os endpoints operacionais só honram `tenant_id` para superadmin; para
  os demais, o escopo vem do JWT (o `tenant_id` da query é **ignorado**). Testado.
- Respostas de `GET /api/clients/:id` trazem só `{id,name,status}` — nada sensível.

## Tarja de contexto
Quando há cliente ativo, `TenantBanner` exibe uma faixa fixa (tom **`info`**, distinta do banner
`AMBIENTE DE TESTES` tom `warning`) em todas as telas, com o botão **Sair do modo cliente**. As duas
faixas coexistem empilhadas, sem sobreposição, em desktop e mobile.

## Menu (Sidebar)
- **Principal**: Painel, Conversas, Grupos, Contatos, Relatórios, Auditoria, **Conexões**.
- **Configurações** (recolhível): Clientes, Usuários, Equipes. *(Integrações fica para a Etapa B.)*
- **Conexões** aparece: para admin/gestor/usuário conforme papel; para superadmin **apenas no modo
  cliente**.
- **Seletor de cliente** ("Cliente ativo") só para superadmin: Visão global (padrão), busca por nome/
  #id, item por tenant e ação de sair.

## Escopo das telas
- **Conversas/Grupos**: na visão global do superadmin exibem um **estado orientativo** ("selecione um
  cliente") — nunca misturam tenants numa caixa operacional. No modo cliente, escopadas ao tenant
  (instâncias/equipes/usuários/contatos/filtros/thread), com os filtros globais ocultos.
- **Conexões (superadmin, modo cliente)**: `ClientConnectionsView` — **somente leitura**, campos
  **seguros** (nome, número **mascarado**, status, captura mapeada/não, proprietário, equipes). Não
  expõe token/webhook/`capture_wid` cru.
- **Painel/Relatórios/Auditoria/Contatos/Usuários/Equipes**: recebem `tenantId` (lock) no modo cliente
  → escopam ao tenant e ocultam o seletor interno; na visão global mantêm o comportamento agregado.

## Troca/saída de cliente (limpeza)
- Cada tela operacional é remontada por uma `key` que muda ao trocar/sair (`activeTenant?.id ?? global`)
  → limpa filtros, fecha thread aberta e descarta cache/estado do tenant anterior.
- Requisições em andamento são canceladas via `AbortController`/flag `alive` nas telas.
- Ao **sair** do modo cliente: diálogos ligados ao tenant são fechados e a navegação volta a uma tela
  global segura (**Painel**).

## Papéis (RBAC)
- **superadmin**: seletor + visão global + modo cliente; vê Clientes e Auditoria global; Conexões só no
  modo cliente.
- **admin**: sem seletor; opera automaticamente no próprio tenant; vê Conexões/Usuários/Equipes; não
  altera o tenant pela URL.
- **gestor/usuário**: escopo inalterado; sem acesso a configurações administrativas.

## Limitações / próxima etapa
- **Integrações** (Configurações) e o webhook em lote são a **Etapa B** (PR separado) — não incluídos aqui.
