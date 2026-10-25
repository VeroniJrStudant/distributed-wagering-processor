# Processador distribuído de apostas

Serviço de carteira e apostas para a Jungle Gaming. Cada aposta é aplicada uma vez, o saldo nunca fica negativo e o razão (ledger) é a fonte da verdade do saldo. A API HTTP e o consumidor SQS usam o mesmo caso de uso.

## Pré-requisitos

- Bun 1.2
- Docker, com o comando `docker-compose` disponível (no macOS com Colima, o plugin `docker compose` pode não estar instalado)

## Subir

```bash
bun install
cp .env.example .env
bun run infra:up
bun run migration:up
bun run start
```

`infra:up` sobe Postgres 16 e LocalStack (SQS) nas portas 5432 e 4566. O script de inicialização do LocalStack cria as filas FIFO `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `integration-events.fifo`.

`APP_ROLE=all` sobe a API e os workers no mesmo processo. Para separar:

```bash
APP_ROLE=api bun run start
APP_ROLE=worker bun run start:consumer
```

Várias instâncias são processos do sistema operacional compartilhando o mesmo Postgres e as mesmas filas. O `docker-compose` publica a porta 3000 uma vez; escalar o serviço `app` no Compose colide nessa porta.

`bun run docker:up` sobe a infra e a imagem da aplicação, que aplica as migrations antes de escutar.

## Variáveis

Os padrões estão em `.env.example`. A senha `wager` vale só para o Postgres local. Não commitar `.env`.

| Variável | Função |
| --- | --- |
| `APP_ROLE` | `all`, `api` ou `worker` |
| `DATABASE_URL` | Postgres |
| `SQS_ENDPOINT` | LocalStack ou SQS |
| `REFERENCE_MAX_ATTEMPTS` | tentativas do worker de referência pendente (padrão 8) |
| `REFERENCE_BACKOFF_BASE_MS` / `REFERENCE_BACKOFF_CAP_MS` | backoff exponencial, teto 60s |
| `EAGER_REFERENCE_RESOLUTION` | `false` desliga a resolução da referência dentro da transação da aposta citada |
| `CRASH_AFTER_COMMIT` | `1` encerra o processo depois do commit e antes do ack. Só para teste |

## Testes

Postgres e LocalStack precisam estar no ar (`bun run infra:up`).

```bash
bun run test:unit
bun run test:integration
bun run test:concurrency
bun run test:all
bun run typecheck
bun run test:load
```

Os testes de integração e concorrência criam um banco por arquivo e filas com o pid do processo. `test:load` também cria e apaga o próprio banco. Não há meta de RPS: o script imprime latência, taxa de erro, conflitos de lock e atraso do outbox numa execução local.

## Endpoints

| Método | Caminho | Resultado |
| --- | --- | --- |
| `POST` | `/wallets` | 201. Duplicar jogador e moeda devolve 409 |
| `GET` | `/wallets/:id` | carteira |
| `GET` | `/wallets/:id/ledger?cursor&limit` | razão, cursor opaco, limite padrão 50 e máximo 100 |
| `POST` | `/wallets/:id/reconciliation` | 200 mesmo se divergir. Não corrige |
| `POST` | `/wagering/transactions` | exige o header `Idempotency-Key` |
| `GET` | `/wagering/transactions/:id` | transação |
| `GET` | `/providers/:providerId/wagering/transactions/:externalId` | transação pelo id externo |
| `GET` | `/health/live` e `/health/ready` | sem autenticação. Ready devolve 503 se Postgres ou SQS estiver fora |
| `GET` | `/metrics` | texto Prometheus |

Status de negócio no `POST /wagering/transactions`: 200 `PROCESSED`, 202 `PENDING` ou `PENDING_REFERENCE`, 422 `REJECTED` (o corpo traz `failureCode`). 409 é conflito de idempotência. 400 é payload inválido. 404 é carteira ou transação inexistente.

Valores monetários são strings com duas casas (`"10.00"`). `number` é rejeitado.

## Autenticação

Não há tabela de usuários nem validação de token. O enunciado marca autenticação com zero pontos. `AuthGuard` e `ProviderIdentityPort` são os pontos de extensão e hoje deixam a requisição passar. `/health` e `/metrics` continuam explícitos. O desenho com Keycloak está em `ARCHITECTURE.md`.
