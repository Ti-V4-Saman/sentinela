# Sentinela — instruções do projeto

Sistema **read-only** de monitoramento de conversas WhatsApp (captura via webhook
QuePasa → MySQL). Multi-tenant + RBAC (superadmin/admin/gestor/usuario) + JWT.

Stack: Vite + React 18 (JS) no front; Express 5 + `mysql2/promise` no back;
Knex **só para migrations** (arquivos `.cjs`); Vitest para testes (rodam contra o
banco em transações com rollback — `npm test`).

## ⛔ Design System — regra bloqueante

Antes de criar ou alterar QUALQUER arquivo de interface (tela, componente,
modal, tabela, layout, estilo), leia `docs/DESIGN-SYSTEM.md` na íntegra.
Isto não é opcional e não tem exceção por tamanho da mudança.

Ao final, percorra o checklist da seção 9 e reporte-o explicitamente.
Se um item falhar, corrija antes de entregar — não entregue com ressalva.

Proibições absolutas: cor hardcoded, azul/roxo usados como decoração em vez de
semântica (`info`/`ia`), recriar do zero componente que já existe no design
system, usar qualquer paleta que não seja a vinho/neutra da seção 3.

## Convenções gerais

- Isolamento por tenant é invariante de segurança: nenhuma rota retorna dados de
  outro tenant. RBAC é recarregado do banco em mutações (não confiar só no JWT).
- Migrations: `.cjs` (projeto é ESM), reversíveis; **nunca** rodar `migrate:rollback`
  no banco vivo. Segredos só em `.env` (git-ignored), nunca commitados.
- Textos de UI em pt-BR. Nada de `window.alert/confirm/prompt` — usar os providers
  de toast/confirmação (`src/components/ui/`).
