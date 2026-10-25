import { afterAll, beforeAll, expect, test } from 'bun:test';
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

const dbName = `wager_msg_${process.pid}`;
const suffix = `${process.pid}msg`;
let app: any;

beforeAll(async () => {
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
  process.env.SQS_WAIT_TIME_SECONDS = '1';
  process.env.SQS_VISIBILITY_TIMEOUT = '2';
  for (const name of [process.env.WAGER_QUEUE_NAME, process.env.DLQ_QUEUE_NAME, process.env.EVENTS_QUEUE_NAME]) {
    await createFifo(name!);
  }
  const { migrate } = await import('../../src/infrastructure/persistence/migrate.ts');
  await migrate(databaseUrl, 'up');
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../../src/app.module.ts');
  app = await NestFactory.createApplicationContext(AppModule, { logger: false });
});

afterAll(async () => {
  const { WagerConsumer } = await import('../../src/infrastructure/messaging/consumer.ts');
  await app?.get(WagerConsumer).stop();
  await app?.close();
  await dropDatabase(dbName);
});

test('an invalid message is dead-lettered and a missing wallet is retried', async () => {
  const { APP_CONFIG } = await import('../../src/config.ts');
  const { WagerConsumer } = await import('../../src/infrastructure/messaging/consumer.ts');
  const { Metrics } = await import('../../src/infrastructure/observability/metrics.ts');
  const config = app.get(APP_CONFIG);
  const consumer = app.get(WagerConsumer);
  consumer.start();
  try {
    await send(config.wagerQueueName, 'bad-json', '{');
    const dead = JSON.parse(await waitForBody(config.dlqQueueName, 8000)) as { body: string };
    expect(dead.body).toBe('{');

    await send(config.wagerQueueName, 'missing-wallet', JSON.stringify({
      messageId: 'msg-missing-wallet',
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-a',
        externalTransactionId: 'missing-wallet',
        idempotencyKey: 'provider-a:missing-wallet',
        playerId: uuidv7(),
        walletId: uuidv7(),
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '1.00', currency: 'BRL' },
      },
    }));
    await waitFor(() => /retries_total\{source="sqs"\} [1-9]/.test(app.get(Metrics).render()), 8000);
  } finally {
    await consumer.stop();
  }

  expect(await receiveOnce(config.dlqQueueName)).toBe(0);
  await sleep(2500);
  expect(await receiveOnce(config.wagerQueueName)).toBe(1);
}, 20000);

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

async function send(queueName: string, dedup: string, body: string): Promise<void> {
  const client = sqs();
  await client.send(new SendMessageCommand({
    QueueUrl: await queueUrl(queueName),
    MessageBody: body,
    MessageGroupId: dedup,
    MessageDeduplicationId: dedup,
  }));
  client.destroy();
}

async function waitForBody(name: string, timeoutMs: number): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const body = await takeOne(name, 1);
    if (body) return body;
  }
  throw new Error(`no message on ${name}`);
}

async function receiveOnce(name: string): Promise<number> {
  return (await takeOne(name, 1)) ? 1 : 0;
}

async function takeOne(name: string, waitSeconds: number): Promise<string | undefined> {
  const client = sqs();
  const url = await queueUrl(name);
  const result = await client.send(new ReceiveMessageCommand({
    QueueUrl: url,
    MaxNumberOfMessages: 1,
    WaitTimeSeconds: waitSeconds,
  }));
  const message = result.Messages?.[0];
  if (message?.ReceiptHandle) {
    await client.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle }));
  }
  client.destroy();
  return message?.Body;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error('condition was not met');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
