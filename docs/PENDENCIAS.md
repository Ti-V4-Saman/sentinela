# Pendências

Itens conhecidos, adiados de propósito, com a fase a que pertencem.

## Fase 2 — Busca

- **Migration: índice FULLTEXT em `messages.text`.** A transcrição de áudio já vive em
  `messages.text` (`type='audio'`), então a busca por palavra-chave cobre áudio — mas hoje
  seria `LIKE` (scan). Ao implementar a busca de conteúdo, adicionar
  `ALTER TABLE messages ADD FULLTEXT idx_messages_text (text)` (migration `.cjs`, reversível)
  e usar `MATCH(text) AGAINST(...)`. Registrado em 2026-07-26.

## Ferramentas / QA

- **Lint real com ESLint.** Hoje `npm run lint` executa apenas `vite build` (não faz análise
  estática de fato). Configurar ESLint (flat config, plugins React/hooks + TS) e apontar o script
  `lint` para ele. Não bloqueia o porte do design system. Registrado em 2026-07-26.
- **Validação visual em viewport mobile real.** O ambiente de captura atual fixa o viewport em
  ~1460px e não renderiza largura mobile de fato, então a responsividade das telas portadas foi
  evidenciada apenas por breakpoints Tailwind (`sm:`/`md:`). Refazer a validação visual mobile
  quando o ambiente permitir redimensionamento real. Não bloqueia o próximo bloco. Registrado em 2026-07-26.

## Pré-produção (Design System / deploy)

- Sanitizar/rotacionar segredos reais (token QuePasa, webhook n8n `n8.v4saman.com`, e-mail
  interno, URL do servidor) hoje em `src/services/quepasaApi.js`, `nginx.conf`, `.env.example`,
  `docker-compose.yml` e no histórico git — trocar por credenciais novas no deploy de produção.
- Ao concluir o porte de TODAS as telas para tokens, remover `class="dark"` fixo do `index.html`
  e as classes legadas (`bg-dark-*`, `brand-emerald`, `font-outfit`) para o tema padrão light
  (com sidebar escura fixa) entrar em vigor. Ver `docs/DESIGN-SYSTEM.md` §8/§12.
