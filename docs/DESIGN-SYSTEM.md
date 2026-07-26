# Sentinela — Design System (documento normativo)

> **⛔ LEITURA OBRIGATÓRIA.** Nenhuma tela, componente, modal, tabela ou ajuste visual
> pode ser escrito neste projeto sem que este documento tenha sido lido antes.
> Se você é um agente (Claude Code) e está prestes a criar ou alterar qualquer arquivo
> de UI, **pare e leia este arquivo primeiro**. Não existe exceção por "mudança pequena".

**Fonte da verdade visual:** Design System CRM V4 (repositório separado).
**Status:** em migração — ver seção 2.

---

## 1. Regra de ouro

O Sentinela **não inventa design**. Toda decisão visual já foi tomada no CRM V4.
O trabalho aqui é *consumir* o design system, nunca recriá-lo.

Ordem de precedência quando houver conflito:

1. `Prompts/1.5-component-standards` do CRM V4 (padrões visuais normativos)
2. `docs/ARCHITECTURE.md` do CRM V4 (organização, naming, barrel exports)
3. Tokens em `globals.css` (valores concretos)
4. Este documento (adaptações específicas do Sentinela)
5. Qualquer outra coisa

Se algo não está coberto acima, **pergunte antes de improvisar**.

---

## 2. Decisão de arquitetura: portar, não migrar

O CRM V4 roda em **Next.js 16 + React 19 + TypeScript + Tailwind v4 + shadcn/ui**.
O Sentinela roda em **Vite + React 18 + JavaScript + Tailwind v3 + componentes próprios**.

**Decisão (confirmada):** portar o design system para o Vite. Não migrar o
Sentinela para Next.js.

Justificativa: Tailwind v4 e shadcn/ui têm suporte oficial a Vite. O valor do design
system está nos **tokens** e nos **padrões**, não no framework. Backend Express,
Docker e nginx permanecem intactos.

### 2.1 Plano de porte (ordem obrigatória)

| # | Etapa | Detalhe |
|---|---|---|
| 1 | Tailwind v3 → v4 | Migrar config; adotar `@theme inline` |
| 2 | Importar tokens | Copiar `:root` e `.dark` do `globals.css` do CRM V4 **sem alterar valores** |
| 3 | Habilitar TypeScript | Vite aceita `.jsx` e `.tsx` coexistindo — migração gradual, sem big bang |
| 4 | Instalar shadcn/ui | `npx shadcn@latest init` (style Default, base Neutral, CSS variables) |
| 5 | Portar famílias sob demanda | Só o que a tela em construção precisa; não portar tudo de uma vez |
| 6 | Substituir componentes legados | `InstanceCard`, `Header`, modais → equivalentes do design system |

> **Nunca** copie um componente do CRM V4 alterando cores, radius ou espaçamento
> "para ficar melhor no Sentinela". Se o componente não serve, o caso vira uma
> conversa sobre o design system — não um fork silencioso.

---

## 3. Tokens — inegociável

- **Zero cores hardcoded.** Sempre classe utilitária de token: `bg-primary`,
  `text-muted-foreground`, `border-border`, `bg-success`.
- **Zero azul** em qualquer lugar do sistema. A marca é **emerald** (`primary`).
- Tokens semânticos custom disponíveis além dos padrão shadcn: `success`,
  `warning`, `info` (cada um com `-foreground`).
- Valores em **OKLCH** (convenção do projeto).
- Primary source of truth: `#00B393`.

### 3.1 Classes legadas a eliminar

O Sentinela hoje usa classes que **não existem** no design system e devem ser
substituídas durante o porte:

| Legado (remover) | Substituir por |
|---|---|
| `bg-dark-bg`, `bg-dark-card`, `bg-dark-surface`, `bg-dark-input` | `bg-background`, `bg-card`, `bg-popover`, `bg-input` |
| `border-dark-border` | `border-border` |
| `bg-brand-emerald`, `bg-brand-emeraldDark` | `bg-primary` |
| `text-slate-400`, `text-slate-500` | `text-muted-foreground` |
| `text-rose-400`, `bg-rose-950` | `text-destructive`, tokens destructive |
| `font-outfit` | `font-heading` |

---

## 4. Radius por intenção

| Tipo | Radius |
|---|---|
| Form controls (Input, Select, Textarea, Combobox, DatePicker, Button) | `rounded-md` (~6px) |
| Flutuantes (Popover, Dropdown, Context Menu, Command, Tooltip) | `rounded-lg` (~8px) |
| Containers (Card, Dialog, Drawer, Calendar, containers de tabela) | `rounded-lg` (~10px) |
| Pílulas (Badge, Tag, Status) | `rounded-full` |
| Avatares | sempre circular |

**Proibido:** `rounded-xl` / `rounded-2xl` em form controls; literais arbitrários
(`rounded-[4px]`) fora das exceções já documentadas no CRM V4.

---

## 5. Sombras, bordas e foco

- Sombras **semânticas apenas**: `shadow-[var(--shadow-card)]` (cards),
  `--shadow-dropdown` (flutuantes), `--shadow-modal` (dialogs).
- Bordas sutis: `border-border`. Sem contornos grossos.
- Foco: `focus-visible:ring-ring/50` — **nunca** `focus:ring-primary`.

---

## 6. Densidade e tipografia

Referência visual: **HubSpot, Linear, Atlassian, Notion, Stripe Dashboard**.

- Densidade **enterprise média** — o Sentinela é ferramenta de trabalho, exibe
  volume alto de conversas. Paddings generosos de "site de marketing" são erro.
- Títulos semibold, corpo regular, descrições muted. Sem headings gigantes.
- Fonte: **Inter** (texto e headings), **Geist Mono** (código, telefones, IDs).

Use os componentes da família `typography` (`Heading`, `Text`, `InlineCode`,
`TextLink`, `Prose`) — não escreva `text-2xl font-bold` solto.

---

## 7. Componentes: famílias, não peças soltas

Regra herdada do CRM V4: **não se cria componente isolado**. Todo componente
pertence a uma família com todas as variantes esperadas de um sistema enterprise.

Famílias já existentes no CRM V4 que o Sentinela vai consumir:

| Família | Uso previsto no Sentinela |
|---|---|
| `data-table` (`CRMDataTable`) | Telas de conversas, drill-down de cliente, fila de identificação |
| `message` | **Thread de conversa** — `Message`, `MessageThread`, `MessageGroup`, `DateSeparator`, `SystemMessage`, `MessageAttachment` |
| `cards` (`StatCard`, `EntityCard`, `EmptyStateCard`) | KPIs de topo, listas, estados vazios |
| `charts` | Dashboard/analytics (fase futura) |
| `badge` (`StatusBadge`, `Tag`) | Status de conexão, tipo de contato, filtros aplicados |
| `input-group` (`SearchInput`) | Busca em todas as telas |
| `field` | Formulários (Cliente, Usuário, Equipe, Identificação) |
| `dialog` (`FormDialog`) | Todos os modais |
| `tabs` | Navegação interna de telas |
| `typography` | Todo texto |

> **A família `message` já existe e foi projetada exatamente para isto.**
> Não construa a thread de conversa do zero — é o erro mais provável desta fase.

### 7.1 Onde colocar componentes novos

Seguindo `docs/ARCHITECTURE.md` do CRM V4:

```
components/
├── ui/                      # primitivos shadcn — não carregam identidade visual própria
├── <família>/               # famílias multi-arquivo + index.ts (barrel)
└── crm-<nome>.tsx           # wrapper fino sobre UM primitivo ui/
```

- Importar sempre pelo barrel: `@/components/<família>`.
- Wrapper que precisa de um segundo arquivo **vira pasta** com `index.ts`.

---

## 8. Modo claro e escuro

O design system suporta os dois via tokens. O Sentinela hoje é dark-only e
hardcoded — isso **deixa de ser aceitável** após o porte.

Toda tela nova deve funcionar em light e dark **sem uma linha de condicional**:
se você escreveu `dark:` manualmente para corrigir uma cor, o token está errado.

> Nota: os screenshots de benchmark de referência estão em **light mode**. Confirmar
> com o time qual será o tema padrão do Sentinela (ver seção 12).

---

## 9. Checklist obrigatório antes de entregar qualquer tela

Nenhuma UI é considerada pronta sem todos os itens abaixo:

- [ ] Li este documento e o `component-standards` do CRM V4
- [ ] Zero cores hardcoded — tudo via token
- [ ] Zero azul
- [ ] Radius conforme a tabela da seção 4
- [ ] Sombras semânticas apenas
- [ ] Foco em `focus-visible:ring-ring/50`
- [ ] Funciona em light **e** dark sem condicional manual
- [ ] Usa famílias existentes; não recriou componente que já existe
- [ ] Estados cobertos: **loading, vazio, erro** (não só o caminho feliz)
- [ ] Textos em **pt-BR**
- [ ] Acessibilidade: foco por teclado, `aria-label` em botão só-ícone, significado
      nunca transmitido só por cor
- [ ] Densidade enterprise — não "marketing website"
- [ ] `npm run build` e lint passam

---

## 10. Aplicação aos benchmarks de referência

Os screenshots fornecidos como referência mapeiam assim:

**Tela "Gestão de Conexões" (benchmark 1):**
- Cards de KPI no topo → `StatCard` (família `cards`)
- Busca + botão Filtrar → `SearchInput` (`input-group`) + `Popover` de filtros
- Tabela → `CRMDataTable` com `CellBadge` (status), `CellDate` (última atualização)
- Status "Conectado/Desconectado" → `StatusBadge` com `tone` semântico
  (`success` / `destructive`), **nunca cor crua**

**Tela de conversa (benchmark 2):**
- Header com avatar + telefone → `EntityCard` ou header próprio + `Avatar`
- Abas (Mensagens / Timeline / Estatísticas…) → `Tabs` variant `line`
- Thread → família `message` completa: `MessageThread` + `Message`
  (`incoming`/`outgoing`) + `DateSeparator` + `MessageAttachment`
- Transcrição de áudio → ver seção 11, é funcionalidade nova a discutir

---

## 11. Transcrição de áudio (confirmado — já existe)

As mensagens de áudio **já chegam transcritas** ao banco: o n8n faz a transcrição
antes de gravar. Não há pipeline de STT a construir e não há custo novo.

Implicações para a UI e para a busca:

- A bolha de áudio deve exibir **o player/indicador + a transcrição**, como no
  benchmark 2 — usar `MessageAttachment` da família `message` para o áudio e o
  corpo da bolha para o texto transcrito.
- A busca por palavra-chave **funciona também em áudio** desde o primeiro dia.
  Isso aumenta muito o valor do filtro de conteúdo previsto na Fase 3.
- **Confirmado no schema (2026-07-25):** a transcrição está em **`messages.text`**
  com **`type='audio'`** — NÃO há coluna separada. Portanto a busca full-text sobre
  `messages.text` cobre áudio automaticamente (sem `OR` adicional). Ainda **não
  existe índice FULLTEXT** em `messages`; ao construir a busca, criar
  `FULLTEXT(text)` para performance (hoje seria `LIKE`).

## 12. Pontos em aberto

1. **Tema padrão:** light ou dark? Os benchmarks são light; o Sentinela hoje é dark.
2. **TypeScript:** confirmar adoção gradual (recomendado) vs. manter JS e portar
   componentes shadcn convertidos para `.jsx` (perde tipagem e diverge do upstream).
3. **Acesso ao CRM V4:** o porte depende de acesso às fontes do CRM V4
   (`globals.css` com os tokens, `Prompts/1.5-component-standards`, `docs/ARCHITECTURE.md`,
   e o código das famílias — em especial `message`, `data-table`, `cards`, `field`,
   `dialog`, `badge`, `input-group`, `typography`). Sem essas fontes não é possível
   consumir o design system sem violar a regra de ouro (seção 1).

---

## 13. Instrução permanente para agentes

Adicionar ao `CLAUDE.md` / `AGENTS.md` do Sentinela:

```markdown
## Design System — regra bloqueante

Antes de criar ou alterar QUALQUER arquivo de interface (tela, componente,
modal, tabela, layout, estilo), leia `docs/DESIGN-SYSTEM.md` na íntegra.
Isto não é opcional e não tem exceção por tamanho da mudança.

Ao final, percorra o checklist da seção 9 e reporte-o explicitamente.
Se um item falhar, corrija antes de entregar — não entregue com ressalva.

Proibições absolutas: cor hardcoded, qualquer tom de azul, recriar do zero
componente que já existe no design system.
```
