import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { Client } from 'pg';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { uuidv7 } from '../../src/domain/ids.ts';
import { createDatabase, dropDatabase } from '../support/database.ts';
import { request } from '../support/http.ts';

const dbName = `wager_race_${process.pid}`;
const suffix = `${process.pid}race`;
let databaseUrl = '';
let baseUrl = '';
let app: any;

beforeAll(async () => {
  databaseUrl = await createDatabase(dbName);
  process.env.DATABASE_URL = databaseUrl;
  process.env.APP_ROLE = 'api';
  process.env.SQS_ENDPOINT = 'http://127.0.0.1:4566';
  process.env.AWS_REGION = 'us-east-1';
  process.env.AWS_ACCESS_KEY_ID = 'test';
  process.env.AWS_SECRET_ACCESS_KEY = 'test';
  process.env.WAGER_QUEUE_NAME = `wager-${suffix}.fifo`;
  process.env.DLQ_QUEUE_NAME = `dlq-${suffix}.fifo`;
  process.env.EVENTS_QUEUE_NAME = `events-${suffix}.fifo`;
  process.env.SQS_WAIT_TIME_SECONDS = '1';
  process.env.SQS_VISIBILITY_TIMEOUT = '2';
  for (const name of [process.env.WAGER_QUEUE_NAME, process.env.DLQ_QUEUE_NAME, process.env.EVENTS_QUEUE_NAME]) {
    await createFifo(name);
  }
  const { migrate } = await import('../../src/infrastructure/persistence/migrate.ts');
  await migrate(databaseUrl, 'up');
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../../src/app.module.ts');
  const nest = await NestFactory.create(AppModule, { logger: false });
  await nest.listen(0);
  const address = nest.getHttpServer().address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  app = nest;
});

afterAll(async () => {
  await app?.close();
  await dropDatabase(dbName);
});

test('fifty identical bets produce one debit', async () => {
  const { walletId, playerId } = await open('100.00');
  const results = await Promise.all(Array.from({ length: 50 }, () => bet(walletId, playerId, '25.00', 'same-bet')));
  const fresh = results.filter((result) => result.body.idempotentReplay === false);
  const replays = results.filter((result) => result.body.idempotentReplay === true);
  expect(results.every((result) => result.status === 200)).toBe(true);
  expect(fresh).toHaveLength(1);
  expect(replays).toHaveLength(49);
  expect(await balanceOf(walletId)).toBe('75.00');
  expect(await countDebits(walletId)).toBe(1);
});

test('two bets cannot both spend the same balance', async () => {
  const { walletId, playerId } = await open('100.00');
  const results = await Promise.all([
    bet(walletId, playerId, '80.00', 'hot-a'),
    bet(walletId, playerId, '80.00', 'hot-b'),
  ]);
  const processed = results.filter((result) => result.body.status === 'PROCESSED');
  const rejected = results.filter((result) => result.body.status === 'REJECTED');
  expect(processed).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect(rejected[0]?.body.failureCode).toBe('INSUFFICIENT_FUNDS');
  expect(await balanceOf(walletId)).toBe('20.00');
  expect(await countDebits(walletId)).toBe(1);
});

test('distinct wallets are processed in parallel', async () => {
  const first = await open('40.00');
  const second = await open('40.00');
  const results = await Promise.all([
    bet(first.walletId, first.playerId, '15.00', 'parallel-a'),
    bet(second.walletId, second.playerId, '15.00', 'parallel-b'),
  ]);
  expect(results.map((result) => result.body.status)).toEqual(['PROCESSED', 'PROCESSED']);
  expect(await balanceOf(first.walletId)).toBe('25.00');
  expect(await balanceOf(second.walletId)).toBe('25.00');
});

test('three processes share one wallet without losing an update', async () => {
  const { walletId, playerId } = await open('100.00');
  const results = await Promise.all([
    submitViaProcess(walletId, playerId, '40.00', 'proc-a'),
    submitViaProcess(walletId, playerId, '40.00', 'proc-b'),
    submitViaProcess(walletId, playerId, '40.00', 'proc-c'),
  ]);
  expect(results.filter((result) => result.status === 'PROCESSED')).toHaveLength(2);
  expect(results.filter((result) => result.status === 'REJECTED')).toHaveLength(1);
  expect(await balanceOf(walletId)).toBe('20.00');
  expect(await countDebits(walletId)).toBe(2);
});

test('a consumer that dies after commit does not apply the bet again', async () => {
  const { walletId, playerId } = await open('70.00');
  const external = 'crash-bet';
  await sendWager({ walletId, playerId, external, amount: '10.00' });
  const crashed = spawn('bun', ['src/main.ts'], {
    env: { ...process.env, APP_ROLE: 'worker', CRASH_AFTER_COMMIT: '1', PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exitCode = await waitForExit(crashed, 20000);
  expect(exitCode).toBe(1);
  expect(await countDebits(walletId)).toBe(1);
  const recovered = spawn('bun', ['src/main.ts'], {
    env: { ...process.env, APP_ROLE: 'worker', CRASH_AFTER_COMMIT: '0', PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await sleep(8000);
  recovered.kill('SIGTERM');
  await waitForExit(recovered, 10000);
  expect(await countDebits(walletId)).toBe(1);
  expect(await balanceOf(walletId)).toBe('60.00');
  const leftover = await receiveOnce(process.env.WAGER_QUEUE_NAME!);
  expect(leftover).toBe(0);
}, 40000);

test('two publishers claim each outbox row once', async () => {
  const { OutboxPublisher } = await import('../../src/infrastructure/messaging/outbox-publisher.ts');
  const publisher = app.get(OutboxPublisher);
  const client = await pg();
  for (let round = 0; round < 8; round += 1) {
    const published = await Promise.all([publisher.publishBatch(), publisher.publishBatch()]);
    if (published.every((count: number) => count === 0)) break;
  }
  let total = 0;
  try {
    const pending = await client.query('SELECT COUNT(*)::int AS count FROM outbox_messages WHERE published_at IS NULL');
    const all = await client.query('SELECT COUNT(*)::int AS count FROM outbox_messages');
    expect(pending.rows[0].count).toBe(0);
    total = all.rows[0].count;
  } finally {
    await client.end();
  }
  const bodies = await drain(process.env.EVENTS_QUEUE_NAME!);
  const ids = new Set(bodies.map((body) => JSON.parse(body).eventId as string));
  expect(ids.size).toBe(total);
});

async function open(amount: string): Promise<{ walletId: string; playerId: string }> {
  const playerId = uuidv7();
  const created = await request(baseUrl, 'POST', '/wallets', {
    playerId,
    initialBalance: { amount, currency: 'BRL' },
  });
  expect(created.status).toBe(201);
  return { walletId: created.body.id, playerId };
}

function bet(walletId: string, playerId: string, amount: string, external: string) {
  return request(baseUrl, 'POST', '/wagering/transactions', {
    providerId: 'provider-a',
    externalTransactionId: external,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  }, { 'idempotency-key': `provider-a:${external}` });
}

function submitViaProcess(walletId: string, playerId: string, amount: string, external: string): Promise<{ status: string }> {
  const payload = {
    idempotencyKey: `provider-a:${external}`,
    providerId: 'provider-a',
    externalTransactionId: external,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
  return new Promise((resolve, reject) => {
    const child = spawn('bun', ['test/concurrency/submit-worker.ts', JSON.stringify(payload)], { env: process.env });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.stderr.on('data', (chunk) => { err += String(chunk); });
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(err || out));
      else resolve(JSON.parse(out.trim().split('\n').at(-1) ?? '{}'));
    });
  });
}

async function balanceOf(walletId: string): Promise<string> {
  const client = await pg();
  try {
    const result = await client.query('SELECT balance::text AS balance FROM wallets WHERE id = $1', [walletId]);
    return normalize(result.rows[0].balance);
  } finally {
    await client.end();
  }
}

async function countDebits(walletId: string): Promise<number> {
  const client = await pg();
  try {
    const result = await client.query(
      `SELECT COUNT(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = $1 AND direction = 'DEBIT'`,
      [walletId],
    );
    return result.rows[0].count;
  } finally {
    await client.end();
  }
}

function normalize(value: string): string {
  const [whole, frac = ''] = value.split('.');
  return `${whole}.${frac.padEnd(2, '0').slice(0, 2)}`;
}

function pg(): Promise<Client> {
  const client = new Client({ connectionString: databaseUrl });
  return client.connect().then(() => client);
}

function sqs(): SQSClient {
  return new SQSClient({
    region: 'us-east-1',
    endpoint: 'http://127.0.0.1:4566',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
}

async function createFifo(name: string): Promise<void> {
  const client = sqs();
  await client.send(new CreateQueueCommand({
    QueueName: name,
    Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
  }));
  client.destroy();
}

async function queueUrl(name: string): Promise<string> {
  const client = sqs();
  const result = await client.send(new GetQueueUrlCommand({ QueueName: name }));
  client.destroy();
  return result.QueueUrl!;
}

async function sendWager(input: { walletId: string; playerId: string; external: string; amount: string }): Promise<void> {
  const client = sqs();
  await client.send(new SendMessageCommand({
    QueueUrl: await queueUrl(process.env.WAGER_QUEUE_NAME!),
    MessageGroupId: input.walletId,
    MessageDeduplicationId: input.external,
    MessageBody: JSON.stringify({
      messageId: `msg-${input.external}`,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-a',
        externalTransactionId: input.external,
        idempotencyKey: `provider-a:${input.external}`,
        playerId: input.playerId,
        walletId: input.walletId,
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: input.amount, currency: 'BRL' },
      },
    }),
  }));
  client.destroy();
}

async function receiveOnce(name: string): Promise<number> {
  const client = sqs();
  const result = await client.send(new ReceiveMessageCommand({
    QueueUrl: await queueUrl(name),
    MaxNumberOfMessages: 10,
    WaitTimeSeconds: 1,
  }));
  for (const message of result.Messages ?? []) {
    await client.send(new DeleteMessageCommand({ QueueUrl: await queueUrl(name), ReceiptHandle: message.ReceiptHandle! }));
  }
  client.destroy();
  return result.Messages?.length ?? 0;
}

async function drain(name: string): Promise<string[]> {
  const bodies: string[] = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const client = sqs();
    const url = await queueUrl(name);
    const result = await client.send(new ReceiveMessageCommand({
      QueueUrl: url,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
    }));
    const messages = result.Messages ?? [];
    for (const message of messages) {
      if (message.Body) bodies.push(message.Body);
      await client.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle! }));
    }
    client.destroy();
    if (messages.length === 0) break;
  }
  return bodies;
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<number | null> {
  child.stdout?.resume();
  let err = '';
  child.stderr?.on('data', (chunk) => {
    err = `${err}${String(chunk)}`.slice(-2000);
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child timed out\n${err}`));
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
