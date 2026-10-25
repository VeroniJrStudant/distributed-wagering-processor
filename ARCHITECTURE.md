# Arquitetura

O domínio não importa NestJS nem MikroORM. Dinheiro, carteira, transação, inbox, outbox e eventos são objetos imutáveis ou de transição explícita. A aplicação orquestra uma transação SQL. A infraestrutura persiste, publica e expõe HTTP.

A aplicação depende de portas (`UnitOfWork`, `ReadModel`, `AppLogger`, `MetricsPort`, `ProviderIdentityPort`). O `AppModule` é o único lugar que liga essas portas aos adaptadores. O `@Inject` usa símbolo explícito porque o metadata de decorator do Bun é pouco confiável. O domínio permanece puro.

## Dinheiro e persistência

`Money` usa `decimal.js` e só aceita string no formato `^(0|[1-9]\d*)\.\d{2}$` com moeda ISO de três letras. Não há `number` nem `float` no caminho financeiro. A coluna é `numeric(19,2)`. Um tipo do MikroORM recusa o valor se o driver entregar um número JavaScript.

O schema é SQL versionado em `migrations/`, aplicado por um runner próprio. `down` desfaz só a última migration. O MikroORM não sincroniza schema.

Uma carteira existe por par `playerId` + moeda. `version` começa em 1 e sobe só quando o saldo muda. `LOSS` não grava a carteira de novo. Saldo inicial positivo gera uma transação interna `OPENING` e uma linha `CREDIT` na mesma transação SQL; a versão permanece 1, porque a abertura é a criação da carteira, não uma alteração posterior. Saldo inicial zero não gera abertura nem linha de razão.

## Concorrência

A unidade de concorrência é a carteira. O fluxo trava a linha com `SELECT FOR UPDATE` antes de ler a idempotência e de inserir. Não há lock global.

`version` é um contador observável, não o `@Version` automático do MikroORM, que subiria também numa `LOSS`. A proteção contra saldo negativo, razão mutável, transação terminal reescrita, cadeia do razão e `saldo = soma do razão` está no banco: `CHECK`, triggers imediatos e um trigger `DEFERRABLE` que roda no `COMMIT`. Por isso o saldo pode ser atualizado antes do insert do razão, desde que os dois commits juntos fechem.

Deadlock (`40P01`), serialização (`40001`), timeout de lock (`55P03`) e violação de unicidade (`23505`) tentam de novo até três vezes dentro do caso de uso e incrementam `lock_conflicts_total`. Criar carteira duplicada mapeia `23505` para 409 `WALLET_ALREADY_EXISTS`, sem tratar a colisão como sucesso.

Várias instâncias são processos separados no mesmo Postgres. O lock da linha serializa as apostas daquela carteira. Carteiras distintas seguem em paralelo.

## Por que a fila FIFO não basta

SQS FIFO deduplica por uma janela curta e por grupo. Uma reentrega depois dessa janela, um segundo consumidor, ou um produtor que reenviou com outro id de deduplicação aplicaria a aposta de novo se a fila fosse a única trava.

A deduplicação de negócio é a unicidade de `idempotency_key` e de `(provider_id, external_transaction_id)`, mais a inbox `(consumer_name, message_id)`. O consumidor só apaga a mensagem depois do commit. Erro de negócio e conflito 409 também apagam, para não irem à DLQ. Payload inválido vai à DLQ e é apagado. Falha transitória, incluindo carteira ainda inexistente, devolve a mensagem com visibilidade em backoff e, depois de 5 recebimentos, vai à DLQ. `SIGTERM` para o poll, espera o que está em voo ou devolve a visibilidade.

`CRASH_AFTER_COMMIT=1` mata o processo depois do commit e antes do ack. A reentrega encontra a inbox já processada e não debita de novo.

## Idempotência

O header `Idempotency-Key` é a chave no HTTP. Na fila não há header, então `data.idempotencyKey` é obrigatório.

O hash é SHA-256 em hexadecimal do JSON canônico (chaves ordenadas, sem espaço supérfluo) de:

`providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money.amount`, `money.currency`, `referenceExternalTransactionId` (null se ausente).

Header, correlation id e metadados de transporte ficam de fora. A mesma chave com outro payload é 409 `IDEMPOTENCY_PAYLOAD_CONFLICT`, não replay. O mesmo id externo preso a outra chave é 409 `IDEMPOTENCY_KEY_MISMATCH`. O replay devolve o resultado original, inclusive o `observed_balance` gravado naquela execução, com `idempotentReplay: true`.

## Fronteira da transação

Numa única transação SQL entram a trava da carteira, a inbox, a mudança financeira, a linha de razão e o outbox. O evento só é publicado depois do commit. O id do outbox é o `eventId`. Publicar de novo é seguro: a fila FIFO usa esse id como deduplicação.

O publicador reivindica lotes com `FOR UPDATE SKIP LOCKED`. Linha não publicada não é apagada; a falha de publicação reagenda com backoff até 60s. Dois publicadores no mesmo banco não levam a mesma linha.

Eventos, cada um com `version` no tipo: `WagerTransactionProcessed` (inclui `LOSS` e `OPENING`), `WagerTransactionRejected`, `WalletBalanceChanged` só quando o saldo muda, e `WagerTransactionPendingReference` uma vez, quando a transação é estacionada. O `data` carrega `MoneyProps`, não instâncias de `Money`.

## Referência fora de ordem

`REFUND` e `ROLLBACK` exigem referência. Sem ela, o HTTP e a mensagem SQS falham na validação (400, ou DLQ no caso da fila) e nada é gravado. Se o caso de uso for chamado direto, o domínio rejeita `REFERENCE_REQUIRED`.

Se a referência ainda não existe ou não está `PROCESSED`, a transação fica `PENDING_REFERENCE` e responde 202. O primeiro estacionamento arma o retry sem consumir tentativa. O worker incrementa a tentativa com backoff `min(teto, base * 2^(tentativa-1))`. Na oitava tentativa vencida, rejeita `REFERENCE_NOT_FOUND`.

Com a resolução eager ligada (padrão), a transação que acaba de confirmar a aposta citada, ainda segurando o lock da mesma carteira, aplica quem está esperando. O worker continua responsável pelo backoff, pelo estouro de tentativas e pelo caminho com eager desligado.

A referência tem de bater provedor, jogador, carteira, moeda e rodada. `gameId` entra no hash e é persistido, mas não faz parte desse escopo. `WIN` pode citar a `BET` da mesma rodada com valor diferente. `REFUND` e `ROLLBACK` exigem o mesmo valor, sobre uma transação `PROCESSED`. Uma referência aceita um único estorno processado, seja `REFUND` ou `ROLLBACK`: o segundo creditaria de novo e volta `ALREADY_REVERSED`. O índice único parcial `(provider_id, reference_external_transaction_id)` é a trava no banco. `ROLLBACK` do próprio `REFUND` continua válido, porque a referência é outra transação e o efeito é desfazer o crédito. Estorno que deixaria o saldo negativo é `INSUFFICIENT_FUNDS_FOR_REVERSAL`, distinto de `INSUFFICIENT_FUNDS`.

`BET` e `LOSS` podem trazer uma referência. Ela é gravada e entra no hash, mas não segura a transação. `LOSS` não move saldo. Valor que afeta saldo tem de ser positivo; `0.00` nesses tipos é `INVALID_AMOUNT`. `LOSS` pode ser `0.00`.

## Códigos e HTTP

`INSUFFICIENT_FUNDS`, `INSUFFICIENT_FUNDS_FOR_REVERSAL`, `CURRENCY_MISMATCH`, `PLAYER_WALLET_MISMATCH`, `REFERENCE_NOT_FOUND`, `REFERENCE_REQUIRED`, `REFERENCE_KIND_NOT_ALLOWED`, `REFERENCE_SCOPE_MISMATCH`, `AMOUNT_MISMATCH`, `ALREADY_REVERSED`, `INVALID_AMOUNT`, `INVALID_KIND`.

| Situação | HTTP |
| --- | --- |
| `PROCESSED` | 200 |
| `PENDING`, `PENDING_REFERENCE` | 202 |
| `REJECTED` | 422, com `failureCode` |
| conflito de idempotência ou carteira duplicada | 409 |
| payload ou identificador inválido | 400 |
| carteira ou transação ausente | 404 |
| falha transitória de infra | 503 |
| erro interno | 500 |

`FAILED` fica no schema para uma transação que já foi aceita e depois encontra um erro permanente de infraestrutura. Payload inválido na fila não vira linha: não há agregado para auditar, a mensagem vai à DLQ. Rejeição de negócio grava `REJECTED` e emite `WagerTransactionRejected`. Não há linha de razão para `LOSS` nem para rejeição.

## Autenticação

Não há tabela de usuários nem hash de senha. Autenticação vale zero no critério e não compete com correção, concorrência e idempotência. O que está no código é o ponto de extensão; o desenho abaixo é o que eu adotaria.

Keycloak no Compose, realm `jungle`, client confidencial `wagering-api`.

- O `AuthGuard` valida o JWT pelo JWKS do Keycloak: issuer, audience e expiração. Token ausente ou inválido responde 401. `/health` e `/metrics` continuam sem token, como o guard já libera hoje.
- O token traz o claim `provider_id`. `ProviderIdentityPort.assertCanSubmit` compara esse claim com o `providerId` do corpo. Divergência responde 403, antes de qualquer escrita.
- A fila permanece canal interno: rede privada e, em AWS, IAM no produtor. O consumidor não autentica a mensagem, mas chama o mesmo `assertCanSubmit` com o `providerId` do payload. Jogador, carteira, moeda e rodada continuam validados no domínio.
- Papéis e segredos ficam no IdP. A aplicação não guarda senha.

Hoje `AuthGuard.allowRequest` retorna verdadeiro e `UnauthenticatedProviderIdentity` aceita qualquer provedor. Trocar a implementação da porta e a validação do guard não muda o caso de uso.

## Observabilidade

Log JSON com correlation id (`x-correlation-id` válido ou um uuid v7). As chaves `amount`, `balance`, `money`, `payload`, `authorization`, `body`, `initialBalance`, `data`, `password`, `secret` e `observedBalance` são removidas. A resposta HTTP leva os valores; o log leva ids, status e `failureCode`.

`GET /metrics` é texto Prometheus no processo: `wager_transactions_total`, `duplicates_detected_total`, `idempotency_conflicts_total`, `retries_total`, `dlq_messages_total`, `lock_conflicts_total`, `outbox_lag_seconds`, `outbox_publish_total`, `processing_duration_seconds`, `reconciliation_checks_total`, `reconciliation_divergences_total`.

A reconciliação compara o saldo gravado com a soma do razão, responde 200 mesmo divergente, não corrige, e só incrementa a métrica e registra o id da carteira.

Liveness é o processo no ar. Readiness consulta Postgres e a fila. O ORM sobe com `connect: false`, então a API chega a escutar mesmo se o banco estiver fora; readiness devolve 503.

## Limitações

- Criar carteira não é idempotente. Se a resposta se perder, a repetição devolve 409 sem o id.
- Não há estorno parcial.
- Na prática os testes usam BRL. O modelo é multi-moeda: uma carteira por jogador e moeda, e operações misturadas são rejeitadas.
- `gameId` não restringe a referência.
- Referência em `BET` e `LOSS` não bloqueia o processamento.
- `FAILED` não é gravado para mensagem que a validação recusa. Esse caso termina na DLQ.
