import { CreateQueueCommand, SQSClient } from '@aws-sdk/client-sqs';
import { createDatabase, dropDatabase } from '../test/support/database.ts';
import { uuidv7 } from '../src/domain/ids.ts';

const dbName = `wager_load_${process.pid}`;
const suffix = `${process.pid}load`;
const wallets = 10;
const betsPerWallet = 8;
const hotBets = 40;

const databaseUrl = await createDatabase(dbName);
process.env.DATABASE_URL = databaseUrl;
process.env.APP_ROLE = 'api';
process.env.SQS_ENDPOINT = 'http://127.0.0.1:4566';
process.env.AWS_REGION = 'us-east-1';
process.env.AWS_ACCESS_KEY_ID = 'test';
process.env.AWS_SECRET_ACCESS_KEY = 'test';
process.env.WAGER_QUEUE_NAME = `wager-${suffix}.fifo`;
process.env.DLQ_QUEUE_NAME = `dlq-${suffix}.fifo`;
process.env.EVENTS_QUEUE_NAME = `events-${suffix}.fifo`;

try {
  await createQueues();
  const { migrate } = await import('../src/infrastructure/persistence/migrate.ts');
  await migrate(databaseUrl, 'up');
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../src/app.module.ts');
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0);
  const address = app.getHttpServer().address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const report = await run(baseUrl, app);
    console.log(report);
  } finally {
    await app.close();
  }
} finally {
  await dropDatabase(dbName);
}

async function run(baseUrl: string, app: { get: (token: any) => any }): Promise<string> {
  const opened = await Promise.all(Array.from({ length: wallets + 1 }, () => openWallet(baseUrl, '100.00')));
  const spread = opened.slice(0, wallets);
  const hot = opened[wallets]!;
  const samples: number[] = [];
  let failures = 0;
  let rejections = 0;

  const spreadCalls = spread.flatMap((wallet) =>
    Array.from({ length: betsPerWallet }, (_, index) => () =>
      postBet(baseUrl, wallet, `spread-${wallet.walletId.slice(-6)}-${index}`),
    ),
  );
  const hotCalls = Array.from({ length: hotBets }, (_, index) => () =>
    postBet(baseUrl, hot, `hot-${index}`),
  );

  const started = performance.now();
  await runPool([...spreadCalls, ...hotCalls], 20, samples, (status) => {
    if (status >= 500 || status === 0) failures += 1;
    else if (status >= 400) rejections += 1;
  });
  const elapsedSeconds = (performance.now() - started) / 1000;

  const { OutboxPublisher } = await import('../src/infrastructure/messaging/outbox-publisher.ts');
  const publisher = app.get(OutboxPublisher);
  for (let round = 0; round < 20; round += 1) {
    const published = await Promise.all([publisher.publishBatch(), publisher.publishBatch()]);
    if (published.every((count: number) => count === 0)) break;
  }

  const metrics = await (await fetch(`${baseUrl}/metrics`)).text();
  const hotBalance = await (await fetch(`${baseUrl}/wallets/${hot.walletId}`)).json() as {
    balance: { amount: string };
  };
  const sorted = [...samples].sort((left, right) => left - right);
  const total = samples.length;
  const locks = sumMetric(metrics, 'lock_conflicts_total');
  const lag = gauge(metrics, 'outbox_lag_seconds');

  return [
    'Carga local, uma execução. Sem meta de RPS.',
    'Ambiente: um processo Bun no host, Postgres 16 e LocalStack em Colima, APP_ROLE=api.',
    `Carteiras no espalhamento: ${wallets}, apostas de 1.00 em cada: ${betsPerWallet}.`,
    `Carteira quente: ${hotBets} apostas de 1.00 em paralelo lógico, concorrência 20.`,
    `Pedidos: ${total}`,
    `Duração: ${elapsedSeconds.toFixed(2)}s`,
    `Vazão: ${(total / elapsedSeconds).toFixed(1)} req/s`,
    `p50: ${percentile(sorted, 50).toFixed(1)} ms`,
    `p95: ${percentile(sorted, 95).toFixed(1)} ms`,
    `p99: ${percentile(sorted, 99).toFixed(1)} ms`,
    `Erros de transporte ou 5xx: ${failures} (${percent(failures, total)})`,
    `Rejeições de negócio (4xx): ${rejections} (${percent(rejections, total)})`,
    `lock_conflicts_total: ${locks}`,
    `outbox_lag_seconds depois de drenar: ${lag}`,
    `Saldo da carteira quente: ${hotBalance.balance.amount} (esperado 60.00)`,
  ].join('\n');
}

async function runPool(
  jobs: Array<() => Promise<number>>,
  concurrency: number,
  samples: number[],
  onStatus: (status: number) => void,
): Promise<void> {
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const job = jobs[index];
      if (!job) return;
      const started = performance.now();
      const status = await job();
      samples.push(performance.now() - started);
      onStatus(status);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

async function openWallet(baseUrl: string, amount: string): Promise<{ walletId: string; playerId: string }> {
  const playerId = uuidv7();
  const response = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount, currency: 'BRL' } }),
  });
  if (response.status !== 201) throw new Error(`open wallet failed: ${response.status}`);
  const body = await response.json() as { id: string };
  return { walletId: body.id, playerId };
}

async function postBet(
  baseUrl: string,
  wallet: { walletId: string; playerId: string },
  external: string,
): Promise<number> {
  try {
    const response = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `provider-a:${external}`,
      },
      body: JSON.stringify({
        providerId: 'provider-a',
        externalTransactionId: external,
        playerId: wallet.playerId,
        walletId: wallet.walletId,
        roundId: 'round-load',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '1.00', currency: 'BRL' },
      }),
    });
    return response.status;
  } catch {
    return 0;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function percent(part: number, total: number): string {
  if (total === 0) return '0%';
  return `${((part / total) * 100).toFixed(2)}%`;
}

function sumMetric(metrics: string, name: string): number {
  let total = 0;
  for (const line of metrics.split('\n')) {
    if (!line.startsWith(name) || line.startsWith(`${name}_`)) continue;
    const value = Number(line.split(' ').at(-1));
    if (Number.isFinite(value)) total += value;
  }
  return total;
}

function gauge(metrics: string, name: string): string {
  const line = metrics.split('\n').find((item) => item.startsWith(`${name} `) || item.startsWith(`${name}{`));
  return line?.split(' ').at(-1) ?? 'ausente';
}

async function createQueues(): Promise<void> {
  const client = new SQSClient({
    region: 'us-east-1',
    endpoint: 'http://127.0.0.1:4566',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  for (const name of [process.env.WAGER_QUEUE_NAME, process.env.DLQ_QUEUE_NAME, process.env.EVENTS_QUEUE_NAME]) {
    await client.send(new CreateQueueCommand({
      QueueName: name,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }));
  }
  client.destroy();
}
