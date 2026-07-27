# Publicação em ambiente de TESTES (homologação)

Guia para disponibilizar o Sentinela num ambiente **de testes/homologação isolado de operações reais**.
**Segredos nunca vão para o Git** — ficam apenas no `.env` do ambiente.

## Isolamento obrigatório (não tocar em operações reais)
- **`VITE_USE_MOCK=true`** — o frontend usa dados/mocks e **não** chama o QuePasa real.
- **Não** apontar o proxy `/quepasa-proxy/` (nginx) para um QuePasa de produção; usar mock/desativado.
- **Nenhum token real** acessível ao frontend; **nenhum webhook real**; **não** conectar números reais.
- Dados de teste **sintéticos** (ver seed abaixo). Nenhum cliente/contato/mensagem real como seed.

## Identificação visual do ambiente
- Defina a variável de build **`VITE_ENV_LABEL`** (ex.: `VITE_ENV_LABEL="AMBIENTE DE TESTES"`).
- Quando presente, o app exibe uma faixa fixa (token `warning`) no **login** e no topo do **shell**.
- Em produção a variável fica **ausente** → nenhuma faixa.

## Variáveis de ambiente (no `.env` do ambiente de testes — fora do Git)
| Variável | Uso |
|---|---|
| `DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME` | Banco **exclusivo de testes** (não compartilhado com produção). |
| `JWT_SECRET` / `JWT_EXPIRES_IN` | Segredo próprio de teste (não reutilizar produção). |
| `CORS_ORIGINS` | Origem pública do ambiente de testes (ex.: `https://teste.exemplo.com`). |
| `VITE_USE_MOCK` | **`true`** em homologação. |
| `VITE_ENV_LABEL` | `AMBIENTE DE TESTES`. |
| `VITE_QUEPASA_SERVER_URL` / `VITE_QUEPASA_USER` | Mock/placeholder — **não** apontar para produção. |

## Migrations
Ordem (todas já versionadas; aplicar no banco de testes):
```
20260723210644_baseline
… (Fase 1–3)
20260728120000_contact_identification   (identificação de contatos)
20260729120000_access_logs              (auditoria)
```
`npm run migrate` aplica todas as pendentes. **Backup antes**; confirmar o banco-alvo; **não** rodar
`migrate:rollback` após sucesso, salvo falha comprovada.

## Dados sintéticos
Seed de homologação (script mantido fora do repo): cria **Empresa Alpha Teste** (ativa) e **Empresa
Beta Homologação** (suspensa), superadmin/admin/gestor/usuário, instâncias mapeadas e não mapeadas,
equipes+vínculos, conversas individuais e grupo, mensagens text/áudio(transcrição)/imagem/documento,
notas internas, contatos identificados e pendentes, telefone **duplicado** (autopropagação) e um
**conflito** de identificação. Nenhum dado real.

## Deploy (infra existente — Docker/nginx)
1. `npm ci && npm run build` (frontend).
2. Rebuild/atualizar o container (Dockerfile expõe 3001; `npm run server`).
3. Reverse proxy (nginx) + HTTPS do ambiente de testes.
4. Health check da API e do frontend; validar assets e a URL pública.
5. Não derrubar outros serviços do host.

> **Pré-requisito de infra**: host/servidor de testes com acesso de deploy, banco de testes dedicado e
> domínio/SSL próprios — **separados da produção**. Segredos só no ambiente.
