# Contrato: popular `sentinela_instances.capture_wid` (ponte de captura)

> Documento de **contrato**. Nenhuma alteração no n8n/QuePasa é feita nesta branch — isto
> especifica o que o pipeline externo precisa fazer para que gestor/usuário passem a enxergar
> conversas. Enquanto não for implementado, o acesso deles é **fail-closed** (zero conversas).

## Por quê
`messages.wid` referencia a instância de **captura** (`instances.wid`, atribuída pelo QuePasa).
A visibilidade de conversas de gestor/usuário é resolvida a partir das instâncias **gerenciadas**
(`sentinela_instances`, via `team_instances`/`user_instances`). A coluna
`sentinela_instances.capture_wid` liga os dois lados. Sem ela, não há como escopar conversas por
instância com segurança.

## Momento de gravação
No **connect** da instância (quando o QuePasa emite/retorna o `wid` da sessão do WhatsApp),
ou no primeiro evento de webhook que traga o `wid` associado ao token/instância gerenciada.

## Origem exata do identificador
O `wid` é o identificador da instância de captura no QuePasa — o **mesmo valor** que o pipeline
grava em `instances.wid` e em `messages.wid`. O pipeline já conhece a `sentinela_instance`
correspondente porque o `webhook_url`/token do webhook é por-instância.

## Endpoint do Sentinela que recebe o valor
```
PUT /api/instances/:id/capture-wid
Authorization: Bearer <JWT de superadmin ou admin do tenant>
Content-Type: application/json

{ "captureWid": "<wid da instância de captura>" }   // ou { "captureWid": null } para desvincular
```
Regras aplicadas pelo backend (ver `server/routes/instances.js`):
- **Restrito a superadmin/admin.** Não é editável pelo frontend comum nem pelo dono da instância.
- `:id` é o `sentinela_instances.id` (instância gerenciada), escopado ao tenant do ator (admin) ou global (superadmin).
- **Validação de tenant:** o `wid` precisa existir em `instances` e pertencer ao **mesmo tenant** da instância gerenciada → senão `403`/`404`.
- **Anti-duplicação:** `capture_wid` é **único global** — vincular um `wid` já usado por outra instância → `409`.
- `captureWid: null` **remove** a ponte e **revoga** o acesso operacional imediatamente.

Respostas: `200` `{ id, captureWid }` · `404` (instância ou wid inexistente) · `403` (outro tenant) · `409` (wid já vinculado).

## Comportamento em reconexão
Se o `wid` **permanecer o mesmo**, nenhuma ação é necessária (o valor já está gravado).
Se o QuePasa **atribuir um novo `wid`** na reconexão, o pipeline deve chamar o endpoint com o
novo valor (o antigo é substituído). Conversas antigas gravadas sob o `wid` anterior deixam de
casar com a ponte — se for necessário preservar histórico multi-wid, tratar como evolução futura
(hoje o modelo assume 1 instância gerenciada ↔ 1 `wid` corrente).

## Se o identificador mudar
Sobrescrever via o mesmo `PUT` com o novo `captureWid`. A unicidade global impede colisão com
outra instância; a validação de tenant impede vínculo cruzado.

## Validação de tenant (resumo)
`instances.wid` precisa ter `tenant_id` = tenant da `sentinela_instance`. **O pipeline deve
gravar `instances.tenant_id`** ao inserir a linha de captura; sem isso, a ponte é rejeitada
(fail-safe).

## Regra anti-vínculo-duplicado
Garantida no schema por `UNIQUE (capture_wid)` em `sentinela_instances` e surfada como `409`
pelo endpoint. Um `wid` de captura mapeia para **no máximo uma** instância gerenciada.

## Pendências relacionadas (fora deste escopo)
- Popular `team_instances`/`user_instances` (hoje sem CRUD) para gestor/usuário enxergarem conversas.
- Reconciliar o `visibleInstanceIds` de *management* (por `owner_user_id`) com o modelo de vínculos explícitos.
