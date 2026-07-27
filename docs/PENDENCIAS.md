# Pendências

Itens conhecidos, adiados de propósito, com a fase a que pertencem.

## Fase 2 — Conversas

- ✅ **Migration FULLTEXT em `messages.text` — CRIADA E TESTADA LOCALMENTE (2026-07-27), NÃO
  aplicada em produção.** `migrations/20260727130000_fulltext_messages_text.cjs` cria
  `ft_messages_text` (InnoDB, MySQL 8.1). Reversível. **Aplicar em produção só em janela de
  manutenção aprovada** (rebuild/lock proporcional ao volume). A busca de conversas usa
  `MATCH(text) AGAINST(? IN BOOLEAN MODE)` com fallback `LIKE`.
- ✅ **Migration ponte `sentinela_instances.capture_wid` — CRIADA E TESTADA LOCALMENTE
  (2026-07-27), NÃO aplicada em produção.** `migrations/20260727120000_add_capture_wid_bridge.cjs`
  (coluna nullable + `UNIQUE` global). Mesma exigência de **janela aprovada** em produção.
- ✅ **Gestão de `team_instances` / `user_instances` — IMPLEMENTADA (bloco integração-capture-wid-vínculos,
  2026-07-27).** Backend: `GET/POST/DELETE /api/teams/:id/instances` (explícito, substitui o derivado)
  e `GET/POST/DELETE /api/users/:id/instances` (papel `usuario`), com escopo de tenant + anti-duplicação.
  Frontend: aba "Instâncias" no modal de Vínculos da equipe e ação "Instâncias" no usuário. Agora gestor/
  usuário podem receber conversas quando houver vínculo + `capture_wid` mapeado.
- **Preenchimento AUTOMÁTICO de `capture_wid` pelo pipeline — PENDENTE.** O n8n/QuePasa ainda precisa
  gravar `capture_wid` via `PUT /api/instances/:id/capture-wid` (ver `docs/PIPELINE-CAPTURE-WID.md`).
  Como paliativo, superadmin/admin fazem o **mapeamento manual** na Gestão de Conexões (ação "Mapear
  captura" + `GET /api/instances/:id/capture-candidates`). Registrado em 2026-07-27.
- **Drift de visibilidade de *management*.** `tenantScope.visibleInstanceIds` (usado por
  `/api/instances`) resolve por propriedade (`owner_user_id`), divergindo do modelo documentado
  (vínculos explícitos, usado pelas conversas). Reconciliar numa fase futura, sem quebrar os
  testes/RBAC de gerenciamento. Registrado em 2026-07-27.

## Fase 3 — UI de Conversas

- **Filtro por "status de identificação" — ADIADO PARA A FASE 4.** O plano previa filtrar conversas
  por contato identificado/não identificado, mas o schema atual **não tem** coluna de identificação em
  `contacts` (será criada na Fase 4: `display_name`/`contact_type_id`/`linked_user_id`/…). O filtro e a
  coluna correspondente entram junto com a identificação. Registrado em 2026-07-27.
- **"Responsável" (equipe/usuário) por conversa não é exibido na listagem.** É possível **filtrar** por
  equipe/usuário (`team_id`/`user_id`), mas a resposta de `GET /api/chats` não carrega o responsável
  resolvido de cada linha (o contrato só traz a instância). Exibir a coluna exigiria estender a API para
  derivar o vínculo por `capture_wid` → instância → equipe/usuário. Registrado em 2026-07-27.
- ✅ **Paginação da thread (mais recentes primeiro) — CORRIGIDA (2026-07-27).** A página 1 traz as
  mensagens mais recentes; "Carregar mensagens anteriores" (no topo) faz **prepend** das páginas
  anteriores com dedup por `id` e preservação do scroll. Backend pagina em `DESC` e reverte cada
  página para ordem cronológica. Validado ao vivo com thread sintética de 120 mensagens (3 páginas)
  e por testes de contrato (ordem, não-sobreposição, desempate por `id`, fim do histórico).
- **Sem prévia de mídia (herdado da Fase 2).** O schema só guarda `type` + `text`/transcrição; áudio/
  imagem/vídeo/documento renderizam como rótulo + ícone + legenda/transcrição ("sem prévia"). Prévia real
  depende de URL de mídia no pipeline. Registrado em 2026-07-27.

## Ferramentas / QA

- **Cobertura automatizada de comportamentos de thread que dependem do DOM.** A troca rápida de
  conversa (guarda por `keyRef` descarta respostas de paginação obsoletas) e o erro ao "Carregar
  mensagens anteriores" (mostra aviso inline **sem apagar** o histórico já carregado) foram validados
  **por código** e **ao vivo**, mas não há harness DOM (RTL/jsdom) no projeto para testá-los
  automaticamente. A lógica pura de prepend/dedup tem unit test (`test/thread-merge.test.js`); o
  contrato de paginação do backend tem testes de API. Adicionar RTL+jsdom para cobrir o restante.
  Registrado em 2026-07-27.
- **Lint real com ESLint.** Hoje `npm run lint` executa apenas `vite build` (não faz análise
  estática de fato). Configurar ESLint (flat config, plugins React/hooks + TS) e apontar o script
  `lint` para ele. Não bloqueia o porte do design system. Registrado em 2026-07-26.
- **Validação visual em viewport mobile real.** O ambiente de captura atual fixa o viewport em
  ~1460px e não renderiza largura mobile de fato, então a responsividade das telas portadas foi
  evidenciada apenas por breakpoints Tailwind (`sm:`/`md:`). Refazer a validação visual mobile
  quando o ambiente permitir redimensionamento real. Não bloqueia o próximo bloco. Registrado em 2026-07-26.
- **Teste de integração do toast de erro.** O `ToastProvider` (portado para tokens) renderiza os 4
  tipos pelo mesmo bloco JSX; o tipo `error` (destructive + `XCircle`) foi verificado por código, mas
  **não exercitado ao vivo** — nas telas alcançáveis os erros de backend surgem inline, o QuePasa
  falha graciosamente e backend-down pendura o proxy. Adicionar um teste que force `toast.error` e
  valide o render (ícone/token/`role="status"`). Registrado em 2026-07-27.
- **Teste do estado final de conexão via QR.** O passo "conexão concluída" (step 3) do
  `connect-dialog` não foi exercitado ao vivo porque o servidor QuePasa respondeu `503` no ambiente
  de teste. Validar com QuePasa disponível (ou mock que retorne `Connected`) que o polling detecta,
  finaliza e fecha o modal. Registrado em 2026-07-27.

## Pré-produção (Design System / deploy)

- Sanitizar/rotacionar segredos reais (token QuePasa, webhook n8n `n8.v4saman.com`, e-mail
  interno, URL do servidor) hoje em `src/services/quepasaApi.js`, `nginx.conf`, `.env.example`,
  `docker-compose.yml` e no histórico git — trocar por credenciais novas no deploy de produção.
- ✅ **CONCLUÍDO (2026-07-27):** `class="dark"` fixo removido do `index.html` e as classes legadas
  (`bg-dark-*`, `brand-emerald`, `font-outfit`) eliminadas de todo o frontend alcançável. Tema padrão
  light com sidebar escura fixa em vigor; dark via tokens. Não há mais paleta visual legada alcançável.
