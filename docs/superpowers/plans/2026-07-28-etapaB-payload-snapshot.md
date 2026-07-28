# Etapa B — Snapshot imutável do payload (revisão #2 do PR #15)

Fecha o bloqueio de idempotência: hoje `attemptBatchDelivery` reconstrói o payload no momento da
tentativa (`rebuildPartPayload` reconsulta mensagens/config/chunking), então o mesmo `Idempotency-Key`
pode ser reenviado com **corpo diferente** (mensagem editada/apagada, transcrição tardia, config
alterada, chunking mudado, reenvio com HMAC diferente). Correção: **persistir o corpo EXATO na criação
do batch** e sempre assinar+enviar esses bytes. Branch `feat/integracao-webhook-lote`, **sem merge**.
Não habilitar integrações; não configurar cron; não tocar produção/n8n/QuePasa.

## Formato do snapshot

`rawBody` = `JSON.stringify(partPayload)` — a string exata assinada e enviada (allow-list atual, sem
mudança de conteúdo). Persistido por parte do batch:
- **`payload_compressed` LONGBLOB** — `rawBody` comprimido com gzip (`zlib.gzipSync`).
- **`payload_encoding` VARCHAR(32)** — `'gzip'` (esquema versionável; decodificação escolhida por este campo).
- **`payload_sha256` CHAR(64)** — `sha256(utf8(rawBody))` hex, calculado sobre os **bytes exatos** usados
  no HMAC e no envio (NÃO sobre o comprimido).
- **`payload_size_bytes` INT UNSIGNED** — `Buffer.byteLength(rawBody, 'utf8')` (tamanho descomprimido).
- **`payload_created_at` DATETIME**.
- **`target_url_snapshot` VARCHAR(2048)** — `integration.target_url` no momento da criação (o retry e o
  reenvio entregam ao destino originalmente configurado — previsibilidade/auditoria).
- **`content_options_snapshot` JSON NULL** — snapshot mínimo das flags usadas (include_direct/groups/
  from_me/audio_transcripts) para auditoria (não afeta a entrega, pois o corpo já está congelado).

**Nunca persistir no batch:** secret, assinatura, tokens, headers de autenticação, plaintext do secret.

## Regras

1. **Criação atômica (S2):** o job (Fase 1) constrói o payload UMA vez (loadWindowData → buildPayload →
   chunkPayload) e, para cada parte, `createBatch` grava metadata + idempotency_key + part/part_total +
   contagens + snapshot (compressed/sha256/size/encoding/created_at) + target_url_snapshot **juntos** no
   mesmo INSERT. Nunca existe batch utilizável sem snapshot completo.
2. **Duplicate:** `INSERT ... ON DUPLICATE KEY` que encontra batch existente → recupera o existente,
   **confirma a auto-consistência** (`sha256(descomprimir(payload_compressed)) === payload_sha256`);
   **nunca substitui** o snapshot; divergência → **erro explícito de integridade, sem enviar**. Dados de
   origem que mudaram entre execuções NÃO sobrescrevem o snapshot original (o primeiro é autoritativo).
3. **Entrega/retry/reenvio (S3):** `attemptBatchDelivery` **NÃO reconstrói** o payload. Carrega o
   snapshot, descomprime conforme `payload_encoding`, valida `payload_size_bytes` e `payload_sha256`
   (adulteração no banco → erro, **não envia** — teste 8), usa **exatamente** esses bytes: assina
   `HMAC-SHA256(secret_atual, timestamp.rawBody)` e envia `rawBody`. Retry automático e reenvio manual
   usam o **mesmo snapshot** e o **mesmo `target_url_snapshot`**. Batch sem snapshot → não envia (erro
   de integridade — teste 9).
4. **Config posterior:** alterações na integração não mudam batches já criados (payload/part/idempotency/
   hash/URL congelados). URL: retry/reenvio usam `target_url_snapshot` (documentado). Troca de URL para
   reenvio manual: decisão explícita fica para etapa futura; nesta etapa usa o snapshot.
5. **Secret rotacionado:** usa o secret **atual** no momento da tentativa (`getSigningSecret`);
   documentar que a rotação invalida o secret anterior; payload e idempotency_key permanecem imutáveis;
   sem plaintext do secret no batch. O receptor valida com o secret vigente.
6. **Migration (S1):** `20260801150000_integration_batch_payload_snapshot.cjs` — defensiva, reversível,
   valida coluna incompatível, adiciona os campos + índice se necessário. Colunas **NULLABLE** no DB
   (defensivo em banco populado), **completude imposta na aplicação** (createBatch sempre grava;
   attemptBatchDelivery recusa batch sem snapshot). Banco de teste tem 0 batches → sem backfill;
   documentar que, num banco com batches antigos, batches sem snapshot ficam não-entregáveis (erro de
   integridade explícito) até re-criação/backfill manual. Só banco de teste.
7. **Limites/proteção:** manter ~5 MB por parte (chunker já limita). Antes do INSERT validar: tamanho ≤
   limite absoluto de segurança (`PAYLOAD_MAX_BYTES = 8_000_000` descomprimido), JSON serializável,
   hash, encoding conhecido. Listagens/endpoints de batches retornam **só metadata** — o corpo do
   payload **nunca** em listagem, auditoria, logs ou frontend nesta etapa (repo `SELECT` exclui as
   colunas de payload nas listagens; um getter dedicado interno carrega o corpo só para entrega).

## Testes obrigatórios (S3)

1. retry usa os mesmos bytes da 1ª tentativa; 2. mensagem alterada após criação não muda o retry;
3. mensagem excluída após criação não muda o retry; 4. transcrição adicionada depois não muda o retry;
5. config alterada não muda o payload existente; 6. chunking posterior diferente não altera a parte
persistida; 7. mesma idempotency key sempre tem o mesmo SHA-256; 8. payload adulterado no banco é
detectado e não enviado; 9. batch sem snapshot não é enviado; 10. listagem da API não devolve payload;
11. logs e auditoria não incluem payload; 12. reenvio manual usa o mesmo snapshot; 13. redirect/retry
continuam usando o mesmo corpo; 14. HMAC calculado sobre os bytes persistidos; 15. migration up/down +
estado incompatível.

## Validação final (S4)

`npm test` + `npm run build`; revalidar: transporte preso ao IP, TLS/SNI, retry persistido, blocked com
gate off, catch-up, concorrência, payload imutável, hash, ausência de vazamento. Atualizar
`docs/INTEGRACOES.md` + corpo do PR #15; commit+push; PR #15 **aberto, sem merge**.
