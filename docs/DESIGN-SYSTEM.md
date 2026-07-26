# Sentinela — Design System (documento normativo)

> **⛔ LEITURA OBRIGATÓRIA.** Nenhuma tela, componente, modal, tabela ou ajuste visual
> pode ser escrito neste projeto sem que este documento tenha sido lido antes.
> Se você é um agente (Claude Code) e está prestes a criar ou alterar qualquer arquivo
> de UI, **pare e leia este arquivo primeiro**. Não existe exceção por "mudança pequena".

**Fonte da verdade:** este documento. Tokens, cores, tipografia, radius, sombras
e padrões de componente descritos aqui são a identidade própria do Sentinela.
**Status:** em implementação — ver seção 2.

---

## 1. Regra de ouro

O Sentinela **não inventa design a cada tela**. Toda decisão visual documentada
aqui é definitiva; o trabalho de cada nova tela é *aplicar* o design system, não
recriá-lo componente a componente.

Ordem de precedência quando houver conflito:

1. Este documento (cores, tipografia, radius, sombras, padrões de componente)
2. Convenções de organização de código já estabelecidas no projeto (barrel
   exports, nomeação de pastas — ver seção 7)
3. Qualquer outra coisa

Se algo não está coberto acima, **pergunte antes de improvisar**.

---

## 2. Arquitetura: shadcn/ui sobre Vite

O Sentinela roda em **Vite + React 18 + Tailwind v3**. Vamos evoluir para
**Tailwind v4 + shadcn/ui**, mantendo backend Express, Docker e nginx intactos.

### 2.1 Plano de implementação (ordem obrigatória)

| # | Etapa | Detalhe |
|---|---|---|
| 1 | Tailwind v3 → v4 | Migrar config; adotar `@theme inline` |
| 2 | Gerar tokens | Construir `:root`/`.dark` com a paleta da seção 3 |
| 3 | Habilitar TypeScript | Vite aceita `.jsx` e `.tsx` coexistindo — migração gradual, sem big bang |
| 4 | Instalar shadcn/ui | `npx shadcn@latest init` (style Default, base Neutral, CSS variables) |
| 5 | Construir famílias sob demanda | Só o que a tela em construção precisa; não construir tudo de uma vez |
| 6 | Substituir componentes legados | `InstanceCard`, `Header`, modais → equivalentes do design system |

> **Nunca** improvise cor, radius ou espaçamento "para ficar melhor" numa tela
> específica. Se um padrão não serve para um caso novo, isso é uma conversa
> sobre o design system — não um ajuste pontual silencioso.

---

## 3. Tokens — marca do Sentinela

### 3.1 Posicionamento

O Sentinela não é um app de mensagens nem um CRM genérico — é uma **plataforma
executiva de inteligência operacional**. Referências visuais: Linear, Vercel,
Notion, Stripe Dashboard, Slack, GitHub, Datadog.

Proporção de uso de cor na interface: **85% tons neutros / 10% cor primária / 5%
cores semânticas.** A informação é o destaque, não a cor.

### 3.2 Cor primária — vinho

| Token | Hex |
|---|---|
| `primary-700` | `#5F1720` |
| `primary-600` | `#7A1E2A` |
| `primary-500` | `#A32626` (base) |
| `primary-400` | `#C45A5A` |
| `primary-300` | `#E49A9A` |
| `primary-200` | `#F2D5D5` |
| `primary-100` | `#FAECEC` |

Objetivo: elegância e autoridade, **não** agressividade. Nunca usar um vermelho
mais saturado que `primary-500` como cor de marca.

### 3.3 Escala neutra (base de toda a interface)

| Token | Hex | Token | Hex |
|---|---|---|---|
| `neutral-950` | `#0C1117` | `neutral-500` | `#47505C` |
| `neutral-900` | `#101318` | `neutral-400` | `#667085` |
| `neutral-800` | `#181D24` | `neutral-300` | `#98A2B3` |
| `neutral-700` | `#252C36` | `neutral-200` | `#E4E7EC` |
| `neutral-600` | `#313743` | `neutral-100` | `#F2F4F7` |
| | | `neutral-50` | `#F8FAFC` |
| | | `neutral-0` | `#FFFFFF` |

Usada em sidebar, background, cards, inputs, modais, bordas e tipografia. A
personalidade visual do sistema vem principalmente desta escala — não da cor
primária.

### 3.4 Cores semânticas

Cor sempre com função, nunca decorativa, nunca como identidade de marca (a marca
é o vinho `primary`). **Azul e roxo são cores semânticas normais neste projeto**
— não há restrição alguma a elas.

| Cor | Hex | Significado |
|---|---|---|
| Sucesso (verde) | `#22C55E` | Ação concluída, pago, ativo |
| Informação (azul) | `#3882F6` | Informação geral, em andamento |
| Atenção (amarelo) | `#EAB308` | Pendência, prazo próximo, necessário ação |
| Alerta (laranja) | `#FB8922` | Demora na resposta, risco de perda, SLA próximo |
| Erro (vermelho) | `#DC2626` | Erro, cancelado, reprovado, SLA vencido |
| **IA (roxo)** | `#7C3AED` | IA respondeu, análise, insight gerado, automação |
| Neutro (cinza) | `#64748B` | Secundário, desabilitado, inativo |

**`IA` é um token semântico central do Sentinela.** Usar sempre que a interface
exibir algo gerado ou processado por IA (resumo de conversa, insight, sugestão,
automação). Nunca reaproveitar `info` para isso — dado bruto e inteligência
aplicada são conceitos diferentes.

### 3.5 Tipografia

Fonte: **Inter**, sempre pesos leves e espaçamento generoso.

| Nível | Peso | Tamanho/linha |
|---|---|---|
| Display | Bold | 32/40 |
| H1 | Semibold | 24/32 |
| H2 | Semibold | 20/28 |
| H3 | Medium | 18/24 |
| Body | Regular | 14/20 |
| Small | Regular | 12/16 |
| Caption | Regular | 11/14 |

### 3.6 Regra de implementação

- **Zero cores hardcoded.** Sempre classe utilitária de token.
- Valores expressos a partir dos hex acima, **sem aproximação** (usar os hex
  exatos fornecidos; opcionalmente OKLCH desde que sem perda perceptível) — não
  digitar o hex direto no componente.
- Mapear como tokens shadcn: `primary` = escala vinho, `success`/`warning`/`destructive`
  = verde/amarelo/vermelho acima, `info` = azul, `ia` = roxo, e avaliar na
  implementação se `alert` (laranja) vira token próprio ou se funde com `warning`.

### 3.7 Classes legadas a eliminar

O Sentinela hoje usa classes que precisam ser substituídas durante a implementação:

| Legado (remover) | Substituir por |
|---|---|
| `bg-dark-bg`, `bg-dark-card`, `bg-dark-surface`, `bg-dark-input` | `bg-background`, `bg-card`, `bg-popover`, `bg-input` |
| `border-dark-border` | `border-border` |
| `bg-brand-emerald`, `bg-brand-emeraldDark` | `bg-primary` (vinho) |
| `text-slate-400`, `text-slate-500` | `text-muted-foreground` |
| `text-rose-400`, `bg-rose-950` | `text-destructive`, tokens destructive |
| `font-outfit` | `font-heading` |

---

## 4. Radius por intenção

Cada categoria de componente tem um radius fixo, nunca literal arbitrário
escolhido no momento.

| Radius | Uso |
|---|---|
| `4px` | Checkboxes, radios, elementos pequenos |
| `8px` | Form controls (Input, Select, Textarea, Button) |
| `12px` | Cards, containers, modais, tabelas |
| `16px` | Cards de destaque/hero, painéis maiores |
| Full (`rounded-full`) | Badges, pílulas de status, avatares |

**Proibido:** literal fora desta escala (`rounded-[6px]`, `rounded-[10px]` etc.).

---

## 5. Sombras, bordas e foco

Sombras discretas — o design deve parecer "quieto":

| Nível | Valor | Uso |
|---|---|---|
| `sm` | `0 1px 2px rgba(16,24,40,0.05)` | elementos discretos, inputs |
| `md` | `0 4px 12px rgba(16,24,40,0.08)` | cards |
| `lg` | `0 12px 24px rgba(16,24,40,0.10)` | modais, dropdowns, elementos flutuantes |

- Bordas sutis: `border-border` (escala neutra, nunca preto puro). Sem contornos grossos.
- Foco: `focus-visible:ring-ring/50` — **nunca** `focus:ring-primary`.

---

## 6. Densidade, tipografia e princípios de UX

Referência visual: **Linear, Vercel, Notion, Stripe Dashboard, Slack, GitHub,
Datadog**. O Sentinela deve parecer software premium de inteligência de dados,
nunca um app de WhatsApp ou CRM tradicional.

- Layout minimalista, muito espaço em branco, hierarquia visual clara.
- Sidebar escura e minimalista, ícones outline, item ativo destacado só por cor
  e fundo suave (baixo contraste entre estados).
- Cards com fundo uniforme, muito respiro, KPIs grandes, títulos discretos.
- Fonte: **Inter** em todo o texto (ver escala §3.5). Sem headings gigantes fora
  da escala. Geist Mono para código/IDs/telefones.

Princípios de UX que valem para toda evolução do sistema:

1. Clareza acima de estética.
2. A informação é mais importante que a decoração.
3. Cada cor deve possuir um significado (nunca decorativa).
4. Espaçamento é prioridade.
5. Menos elementos, maior produtividade.
6. Todo componente deve ser consistente em todo o sistema.
7. O usuário deve localizar qualquer informação em poucos segundos.

Use componentes de tipografia (`Heading`, `Text`, `InlineCode`, `TextLink`,
`Prose`) mapeados para a escala da seção 3.5 — não escreva `text-2xl font-bold`
solto.

---

## 7. Componentes: famílias, não peças soltas

**Não se cria componente isolado.** Todo componente pertence a uma família com
todas as variantes esperadas de um sistema enterprise (estados: default, hover,
pressed, disabled, loading, erro; tamanhos; variantes semânticas).

Famílias a construir/usar no Sentinela:

| Família | Uso previsto |
|---|---|
| `data-table` | Telas de conversas, drill-down de cliente, fila de identificação |
| `message` | **Thread de conversa** — mensagem, agrupamento, separador de data, mensagem de sistema, anexo |
| `cards` | KPIs de topo, listas, estados vazios |
| `charts` | Dashboard/analytics (fase futura) |
| `badge` | Status de conexão, tipo de contato, filtros aplicados |
| `input-group` | Busca em todas as telas |
| `field` | Formulários (Cliente, Usuário, Equipe, Identificação) |
| `dialog` | Todos os modais |
| `tabs` | Navegação interna de telas |
| `typography` | Todo texto |

> **A família `message` é a peça central da Fase 3** (telas de conversa). Não
> construa a thread de conversa como uma peça isolada — projete a família
> completa desde o início.

### 7.1 Onde colocar componentes novos

```
components/
├── ui/                      # primitivos shadcn — não carregam identidade visual própria
├── <família>/               # famílias multi-arquivo + index.ts (barrel)
└── <nome>.tsx                # wrapper fino sobre UM primitivo ui/
```

- Importar sempre pelo barrel: `@/components/<família>`.
- Wrapper que precisa de um segundo arquivo **vira pasta** com `index.ts`.

---

## 8. Modo claro e escuro

O design system suporta os dois via tokens. O Sentinela hoje é dark-only e
hardcoded — isso **deixa de ser aceitável** após a implementação dos tokens.

Toda tela nova deve funcionar em light e dark **sem uma linha de condicional**:
se você escreveu `dark:` manualmente para corrigir uma cor, o token está errado.

> Nota: tema padrão decidido na seção 12 — light com sidebar escura fixa.

---

## 9. Checklist obrigatório antes de entregar qualquer tela

Nenhuma UI é considerada pronta sem todos os itens abaixo:

- [ ] Li este documento na íntegra
- [ ] Zero cores hardcoded — tudo via token
- [ ] Radius conforme a escala da seção 4 (4/8/12/16px + full)
- [ ] Sombras conforme a escala da seção 5 (sm/md/lg)
- [ ] Foco em `focus-visible:ring-ring/50`
- [ ] Funciona em light **e** dark sem condicional manual
- [ ] Usa famílias existentes; não recriou componente que já existe
- [ ] Estados cobertos: **loading, vazio, erro** (não só o caminho feliz)
- [ ] Conteúdo de IA (resumo, insight, sugestão) usa o token `ia` (roxo), não `info`
- [ ] Textos em **pt-BR**
- [ ] Acessibilidade: foco por teclado, `aria-label` em botão só-ícone, significado
      nunca transmitido só por cor
- [ ] Densidade enterprise, 85/10/5 de neutro/primário/semântico — não "marketing website"
- [ ] `npm run build` e lint passam

---

## 10. Aplicação aos benchmarks de referência

**Tela "Gestão de Conexões" (benchmark 1):**
- Cards de KPI no topo → família `cards`
- Busca + botão Filtrar → `SearchInput` (`input-group`) + `Popover` de filtros
- Tabela → data-table com célula de badge (status), célula de data (última atualização)
- Status "Conectado/Desconectado" → badge com tom semântico
  (`success` / `destructive`), **nunca cor crua**

**Tela de conversa (benchmark 2):**
- Header com avatar + telefone → header próprio + Avatar
- Abas (Mensagens / Timeline / Estatísticas…) → família `tabs`, variante sublinhada
- Thread → família `message` completa: thread + mensagem
  (`incoming`/`outgoing`) + separador de data + anexo
- Transcrição de áudio → ver seção 11 (já vem pronta do n8n)
- Qualquer resumo/insight gerado por IA sobre a conversa → token `ia` (roxo),
  nunca `info` (azul)

---

## 11. Transcrição de áudio (confirmado — já existe)

As mensagens de áudio **já chegam transcritas** ao banco: o n8n faz a transcrição
antes de gravar. Não há pipeline de STT a construir e não há custo novo.

Implicações para a UI e para a busca:

- A bolha de áudio deve exibir **o player/indicador + a transcrição**, como no
  benchmark 2 — usar o componente de anexo da família `message` para o áudio e o
  corpo da bolha para o texto transcrito.
- A busca por palavra-chave **funciona também em áudio** desde o primeiro dia.
  Isso aumenta muito o valor do filtro de conteúdo previsto na Fase 3.
- **Confirmado no schema (2026-07-25):** a transcrição está em **`messages.text`**
  com **`type='audio'`** — NÃO há coluna separada. A busca full-text sobre
  `messages.text` cobre áudio automaticamente (sem `OR` adicional). Ainda **não
  existe índice FULLTEXT** em `messages`; ao construir a busca, criar
  `FULLTEXT(text)` para performance (hoje seria `LIKE`).

---

## 12. Decisões fechadas

1. **Tema padrão: light, com sidebar escura fixa.** A sidebar é descrita como
   "escura, minimalista" enquanto o restante da interface (cards, dashboards) é
   claro — padrão comum em Linear/Notion/Vercel (sidebar escura + conteúdo
   claro). A sidebar **não** troca com o toggle claro/escuro; o conteúdo
   principal sim, via tokens (continua funcionando em dark completo como
   opção, seção 8).
2. **TypeScript: adoção gradual (confirmado).** Novas telas/componentes
   nascem em `.tsx`. Código legado permanece `.jsx` até ser tocado. Não há
   big-bang de conversão.
3. **Paleta: os valores da seção 3 são a fonte da verdade**, fornecidos pelo
   cliente — usar como estão (hex → OKLCH na implementação), sem aproximações.

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

Proibições absolutas: cor hardcoded, azul/roxo usados como decoração em vez de
semântica (`info`/`ia`), recriar do zero componente que já existe no design
system, usar qualquer paleta que não seja a vinho/neutra da seção 3.
```
