import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Client } from 'pg';
import { CreateQueueCommand, SQSClient } from '@aws-sdk/client-sqs';
import { uuidv7 } from '../../src/domain/ids.ts';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager/wager-transaction.ts';
import type { SubmitWagerInput } from '../../src/application/wager-processor.ts';
import { createDatabase, dropDatabase } from '../support/database.ts';
import { request } from '../support/http.ts';

const dbName = `wager_it_${process.pid}`;
const suffix = `${process.pid}it`;
let databaseUrl = '';
let baseUrl = '';
let app: any;
let closed = false;

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
  await createFifo(process.env.WAGER_QUEUE_NAME);
  await createFifo(process.env.DLQ_QUEUE_NAME);
  await createFifo(process.env.EVENTS_QUEUE_NAME);
  const { migrate } = await import('../../src/infrastructure/persistence/migrate.ts');
  await migrate(databaseUrl, 'up');
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../../src/app.module.ts');
  const { JsonLogger } = await import('../../src/infrastructure/observability/logger.ts');
  const { correlationMiddleware } = await import('../../src/interfaces/http/correlation.middleware.ts');
  const { AllExceptionsFilter } = await import('../../src/interfaces/http/exception.filter.ts');
  const nest = await NestFactory.create(AppModule, { logger: false });
  const logger = nest.get(JsonLogger);
  nest.use(correlationMiddleware);
  nest.useGlobalFilters(new AllExceptionsFilter(logger));
  await nest.listen(0);
  const address = nest.getHttpServer().address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  app = nest;
});

afterAll(async () => {
  if (!closed) await app?.close();
  await dropDatabase(dbName);
});

test('opens a wallet, keeps version 1, and rejects a duplicate currency', async () => {
  const playerId = uuidv7();
  const created = await request(baseUrl, 'POST', '/wallets', {
    playerId,
    initialBalance: { amount: '1000.00', currency: 'BRL' },
  });
  expect(created.status).toBe(201);
  expect(created.body).toMatchObject({
    playerId,
    balance: { amount: '1000.00', currency: 'BRL' },
    version: 1,
  });
  const again = await request(baseUrl, 'POST', '/wallets', {
    playerId,
    initialBalance: { amount: '5.00', currency: 'BRL' },
  });
  expect(again.status).toBe(409);
  expect(again.body.error).toBe('WALLET_ALREADY_EXISTS');
  const usd = await request(baseUrl, 'POST', '/wallets', {
    playerId,
    initialBalance: { amount: '3.00', currency: 'USD' },
  });
  expect(usd.status).toBe(201);
});

test('debits once, replays the original balance, and rejects a conflicting payload', async () => {
  const { walletId, playerId } = await open('100.00');
  const first = await bet(walletId, playerId, '25.00', 'bet-a');
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({
    status: 'PROCESSED',
    balance: { amount: '75.00', currency: 'BRL' },
    idempotentReplay: false,
  });
  const second = await bet(walletId, playerId, '10.00', 'bet-b');
  expect(second.body.balance.amount).toBe('65.00');
  const replay = await bet(walletId, playerId, '25.00', 'bet-a');
  expect(replay.status).toBe(200);
  expect(replay.body.idempotentReplay).toBe(true);
  expect(replay.body.transactionId).toBe(first.body.transactionId);
  expect(replay.body.balance.amount).toBe('75.00');
  const conflict = await bet(walletId, playerId, '26.00', 'bet-a');
  expect(conflict.status).toBe(409);
  expect(conflict.body.error).toBe('IDEMPOTENCY_PAYLOAD_CONFLICT');
  expect(await balanceOf(walletId)).toBe('65.00');
});

test('keeps exact scale through 0.10 and 0.20', async () => {
  const { walletId, playerId } = await open('1.00');
  expect((await bet(walletId, playerId, '0.10', 'cent-a')).body.balance.amount).toBe('0.90');
  expect((await bet(walletId, playerId, '0.20', 'cent-b')).body.balance.amount).toBe('0.70');
  expect(await balanceOf(walletId)).toBe('0.70');
});

test('LOSS does not move the balance and a win, refund, and rollback follow the ledger', async () => {
  const { walletId, playerId } = await open('100.00');
  const placed = await bet(walletId, playerId, '30.00', 'round-bet');
  const loss = await submit(walletId, playerId, 'LOSS', '30.00', 'round-loss');
  expect(loss.status).toBe(200);
  expect(loss.body.balance.amount).toBe('70.00');
  expect(await ledgerCount(walletId)).toBe(2);
  const win = await submit(walletId, playerId, 'WIN', '12.00', 'round-win', 'round-bet');
  expect(win.body.balance.amount).toBe('82.00');
  const refund = await submit(walletId, playerId, 'REFUND', '30.00', 'round-refund', 'round-bet');
  expect(refund.status).toBe(200);
  expect(refund.body.balance.amount).toBe('112.00');
  const twice = await submit(walletId, playerId, 'REFUND', '30.00', 'round-refund-2', 'round-bet');
  expect(twice.status).toBe(422);
  expect(twice.body.failureCode).toBe('ALREADY_REVERSED');
  const rollback = await submit(walletId, playerId, 'ROLLBACK', '12.00', 'round-rollback', 'round-win');
  expect(rollback.status).toBe(200);
  expect(rollback.body.balance.amount).toBe('100.00');
  const report = await request(baseUrl, 'POST', `/wallets/${walletId}/reconciliation`);
  expect(report.status).toBe(200);
  expect(report.body).toMatchObject({
    consistent: true,
    storedBalance: { amount: '100.00', currency: 'BRL' },
    calculatedBalance: { amount: '100.00', currency: 'BRL' },
    difference: { amount: '0.00', currency: 'BRL' },
  });
  const page = await request(baseUrl, 'GET', `/wallets/${walletId}/ledger?limit=2`);
  expect(page.body.entries).toHaveLength(2);
  expect(typeof page.body.nextCursor).toBe('string');
  const next = await request(baseUrl, 'GET', `/wallets/${walletId}/ledger?cursor=${page.body.nextCursor}&limit=10`);
  expect(next.body.entries.length).toBeGreaterThan(0);
  const stored = await request(baseUrl, 'GET', `/wagering/transactions/${placed.body.transactionId}`);
  expect(stored.body.externalTransactionId).toBe('round-bet');
  const byExternal = await request(baseUrl, 'GET', `/providers/provider-a/wagering/transactions/round-bet`);
  expect(byExternal.body.id).toBe(placed.body.transactionId);
});

test('a bet is reversed only once, even when the second reversal has the other kind', async () => {
  const { walletId, playerId } = await open('100.00');
  await bet(walletId, playerId, '30.00', 'once-bet');
  const refund = await submit(walletId, playerId, 'REFUND', '30.00', 'once-refund', 'once-bet');
  expect(refund.status).toBe(200);
  expect(await balanceOf(walletId)).toBe('100.00');
  const again = await submit(walletId, playerId, 'ROLLBACK', '30.00', 'once-rollback', 'once-bet');
  expect(again.status).toBe(422);
  expect(again.body.failureCode).toBe('ALREADY_REVERSED');
  expect(await balanceOf(walletId)).toBe('100.00');
  const undoRefund = await submit(walletId, playerId, 'ROLLBACK', '30.00', 'undo-refund', 'once-refund');
  expect(undoRefund.status).toBe(200);
  expect(await balanceOf(walletId)).toBe('70.00');
});

test('rejects business rules without changing the balance', async () => {
  const { walletId, playerId } = await open('20.00');
  const poor = await bet(walletId, playerId, '80.00', 'too-much');
  expect(poor.status).toBe(422);
  expect(poor.body.failureCode).toBe('INSUFFICIENT_FUNDS');
  const wrongPlayer = await submit(walletId, uuidv7(), 'BET', '1.00', 'wrong-player');
  expect(wrongPlayer.status).toBe(422);
  expect(wrongPlayer.body.failureCode).toBe('PLAYER_WALLET_MISMATCH');
  const usd = await request(baseUrl, 'POST', '/wagering/transactions', {
    providerId: 'provider-a',
    externalTransactionId: 'usd-bet',
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '1.00', currency: 'USD' },
  }, { 'idempotency-key': 'provider-a:usd-bet' });
  expect(usd.status).toBe(422);
  expect(usd.body.failureCode).toBe('CURRENCY_MISMATCH');
  const zero = await bet(walletId, playerId, '0.00', 'zero-bet');
  expect(zero.status).toBe(422);
  expect(zero.body.failureCode).toBe('INVALID_AMOUNT');
  expect(await balanceOf(walletId)).toBe('20.00');
  expect(await ledgerCount(walletId)).toBe(1);
});

test('a reversal that would go negative has its own failure code', async () => {
  const { walletId, playerId } = await open('10.00');
  await submit(walletId, playerId, 'WIN', '40.00', 'paid');
  await bet(walletId, playerId, '45.00', 'spent');
  const rollback = await submit(walletId, playerId, 'ROLLBACK', '40.00', 'undo-win', 'paid');
  expect(rollback.status).toBe(422);
  expect(rollback.body.failureCode).toBe('INSUFFICIENT_FUNDS_FOR_REVERSAL');
  expect(await balanceOf(walletId)).toBe('5.00');
});

test('parks a refund that arrives before the bet and applies it when the bet commits', async () => {
  const { walletId, playerId } = await open('100.00');
  const early = await submit(walletId, playerId, 'REFUND', '25.00', 'refund-early', 'bet-later');
  expect(early.status).toBe(202);
  expect(early.body.status).toBe('PENDING_REFERENCE');
  expect(await ledgerCount(walletId)).toBe(1);
  const placed = await bet(walletId, playerId, '25.00', 'bet-later');
  expect(placed.status).toBe(200);
  const refund = await request(baseUrl, 'GET', '/providers/provider-a/wagering/transactions/refund-early');
  expect(refund.body.status).toBe('PROCESSED');
  expect(await balanceOf(walletId)).toBe('100.00');
  expect(await ledgerCount(walletId)).toBe(3);
});

test('rejects a reference that never arrives', async () => {
  const { walletId, playerId } = await open('40.00');
  const pending = await submit(walletId, playerId, 'REFUND', '10.00', 'refund-missing', 'bet-missing');
  const client = await pg();
  try {
    await client.query(
      `UPDATE wager_transactions
       SET attempt_count = 8, next_attempt_at = timestamp '2000-01-01'
       WHERE id = $1`,
      [pending.body.transactionId],
    );
  } finally {
    await client.end();
  }
  const { WagerProcessor } = await import('../../src/application/wager-processor.ts');
  await app.get(WagerProcessor).resume(pending.body.transactionId);
  const stored = await request(baseUrl, 'GET', `/wagering/transactions/${pending.body.transactionId}`);
  expect(stored.body.status).toBe('REJECTED');
  expect(stored.body.failureCode).toBe('REFERENCE_NOT_FOUND');
  expect(await balanceOf(walletId)).toBe('40.00');
});

test('the scheduled worker applies a parked refund when eager resolution is off', async () => {
  const { walletId, playerId } = await open('80.00');
  const processor = await eagerOff();
  const parked = await processor.submit(command(walletId, playerId, WagerTransactionKind.Refund, '15.00', 'worker-refund', 'worker-bet'), {
    correlationId: 'worker-refund',
  });
  expect(parked.body.status).toBe(WagerTransactionStatus.PendingReference);
  const placed = await processor.submit(command(walletId, playerId, WagerTransactionKind.Bet, '15.00', 'worker-bet'), {
    correlationId: 'worker-bet',
  });
  expect(placed.body.status).toBe(WagerTransactionStatus.Processed);
  expect(await balanceOf(walletId)).toBe('65.00');
  const client = await pg();
  try {
    await client.query(`UPDATE wager_transactions SET next_attempt_at = timestamp '2000-01-01' WHERE id = $1`, [
      parked.body.transactionId,
    ]);
  } finally {
    await client.end();
  }
  await processor.resume(parked.body.transactionId);
  expect(await balanceOf(walletId)).toBe('80.00');
  const stored = await request(baseUrl, 'GET', `/wagering/transactions/${parked.body.transactionId}`);
  expect(stored.body.status).toBe('PROCESSED');
});

test('inbox redelivery does not debit twice', async () => {
  const { walletId, playerId } = await open('50.00');
  const { WagerProcessor } = await import('../../src/application/wager-processor.ts');
  const processor = app.get(WagerProcessor);
  const input = command(walletId, playerId, WagerTransactionKind.Bet, '5.00', 'inbox-bet');
  const inbox = { consumerName: 'wager-transactions', messageId: 'msg-inbox-1', payloadHash: 'hash-1' };
  const first = await processor.submit(input, { correlationId: 'inbox', inbox });
  const second = await processor.submit(input, { correlationId: 'inbox', inbox });
  expect(first.body.idempotentReplay).toBe(false);
  expect(second.body.idempotentReplay).toBe(true);
  expect(await ledgerCount(walletId)).toBe(2);
  await expect(processor.submit(
    command(walletId, playerId, WagerTransactionKind.Bet, '5.00', 'inbox-other'),
    { correlationId: 'inbox', inbox: { ...inbox, payloadHash: 'hash-2' } },
  )).rejects.toMatchObject({ code: 'INBOX_PAYLOAD_CONFLICT' });
});

test('a wallet update without a ledger line cannot commit', async () => {
  const { walletId } = await open('30.00');
  const { SqlUnitOfWork } = await import('../../src/infrastructure/persistence/unit-of-work.ts');
  const { Money } = await import('../../src/domain/money/money.ts');
  const uow = app.get(SqlUnitOfWork);
  await expect(uow.run(async (repos: any) => {
    const wallet = await repos.wallets.lockById(walletId);
    wallet.debit(Money.from({ amount: '1.00', currency: 'BRL' }), new Date());
    repos.wallets.save(wallet);
  })).rejects.toThrow(/diverges from ledger|P0001/);
  expect(await balanceOf(walletId)).toBe('30.00');
});

test('schema constraints reject negative balances, ledger edits, and terminal rewrites', async () => {
  const { walletId, playerId } = await open('15.00');
  const placed = await bet(walletId, playerId, '1.00', 'locked-bet');
  const client = await pg();
  try {
    await expect(client.query('UPDATE wallets SET balance = -1 WHERE id = $1', [walletId])).rejects.toThrow();
    await expect(client.query('UPDATE wallet_ledger_entries SET amount = amount + 1 WHERE wallet_id = $1', [walletId])).rejects.toThrow(/immutable/);
    await expect(client.query(`UPDATE wager_transactions SET status = 'REJECTED' WHERE id = $1`, [placed.body.transactionId])).rejects.toThrow(/immutable/);
  } finally {
    await client.end();
  }
});

test('invalid payloads and a missing idempotency key are not business rejections', async () => {
  const missing = await request(baseUrl, 'POST', '/wagering/transactions', { kind: 'BET' });
  expect(missing.status).toBe(400);
  expect(missing.body.error).toBe('IDEMPOTENCY_KEY_REQUIRED');
  const { walletId, playerId } = await open('10.00');
  const bad = await request(baseUrl, 'POST', '/wagering/transactions', {
    providerId: 'provider-a',
    externalTransactionId: 'bad-money',
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '10', currency: 'BRL' },
  }, { 'idempotency-key': 'provider-a:bad-money' });
  expect(bad.status).toBe(400);
  expect(bad.body.error).toBe('INVALID_PAYLOAD');
});

test('health, metrics, and outbox publication', async () => {
  const live = await request(baseUrl, 'GET', '/health/live');
  expect(live.body.status).toBe('ok');
  const ready = await request(baseUrl, 'GET', '/health/ready');
  expect(ready.status).toBe(200);
  const metrics = await fetch(`${baseUrl}/metrics`);
  expect(await metrics.text()).toContain('wager_transactions_total');
  const { OutboxPublisher } = await import('../../src/infrastructure/messaging/outbox-publisher.ts');
  const publisher = app.get(OutboxPublisher);
  const client = await pg();
  try {
    for (let round = 0; round < 8; round += 1) {
      const published = await Promise.all([publisher.publishBatch(), publisher.publishBatch()]);
      if (published.every((count: number) => count === 0)) break;
    }
    const pending = await client.query('SELECT COUNT(*)::int AS count FROM outbox_messages WHERE published_at IS NULL');
    expect(pending.rows[0].count).toBe(0);
  } finally {
    await client.end();
  }
});

test('a new process sees a consistent wallet after restart', async () => {
  const { walletId } = await open('12.00');
  closed = true;
  await app.close();
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../../src/app.module.ts');
  const restarted = await NestFactory.create(AppModule, { logger: false });
  await restarted.listen(0);
  const address = restarted.getHttpServer().address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  app = restarted;
  closed = false;
  const report = await request(baseUrl, 'POST', `/wallets/${walletId}/reconciliation`);
  expect(report.body.consistent).toBe(true);
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
  return submit(walletId, playerId, 'BET', amount, external);
}

function submit(
  walletId: string,
  playerId: string,
  kind: string,
  amount: string,
  external: string,
  reference?: string,
) {
  return request(baseUrl, 'POST', '/wagering/transactions', {
    providerId: 'provider-a',
    externalTransactionId: external,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...(reference ? { referenceExternalTransactionId: reference } : {}),
  }, { 'idempotency-key': `provider-a:${external}` });
}

function command(walletId: string, playerId: string, kind: WagerTransactionKind, amount: string, external: string, reference?: string): SubmitWagerInput {
  return {
    idempotencyKey: `provider-a:${external}`,
    providerId: 'provider-a',
    externalTransactionId: external,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...(reference ? { referenceExternalTransactionId: reference } : {}),
  };
}

async function eagerOff() {
  const { APP_CONFIG } = await import('../../src/config.ts');
  const { WagerProcessor } = await import('../../src/application/wager-processor.ts');
  const { SqlUnitOfWork } = await import('../../src/infrastructure/persistence/unit-of-work.ts');
  const { MikroReadModel } = await import('../../src/infrastructure/persistence/read-model.ts');
  const { SystemClock, UuidGenerator } = await import('../../src/domain/ids.ts');
  const { Metrics } = await import('../../src/infrastructure/observability/metrics.ts');
  const { JsonLogger } = await import('../../src/infrastructure/observability/logger.ts');
  const { UnauthenticatedProviderIdentity } = await import('../../src/infrastructure/auth/provider-identity.ts');
  return new WagerProcessor(
    app.get(SqlUnitOfWork),
    app.get(MikroReadModel),
    app.get(SystemClock),
    app.get(UuidGenerator),
    app.get(Metrics),
    app.get(JsonLogger),
    { ...app.get(APP_CONFIG), eagerReferenceResolution: false },
    app.get(UnauthenticatedProviderIdentity),
  );
}

async function balanceOf(walletId: string): Promise<string> {
  const client = await pg();
  try {
    const result = await client.query('SELECT balance::text AS balance FROM wallets WHERE id = $1', [walletId]);
    return result.rows[0].balance;
  } finally {
    await client.end();
  }
}

async function ledgerCount(walletId: string): Promise<number> {
  const client = await pg();
  try {
    const result = await client.query('SELECT COUNT(*)::int AS count FROM wallet_ledger_entries WHERE wallet_id = $1', [walletId]);
    return result.rows[0].count;
  } finally {
    await client.end();
  }
}

function pg(): Promise<Client> {
  const client = new Client({ connectionString: databaseUrl });
  return client.connect().then(() => client);
}

async function createFifo(name: string): Promise<void> {
  const client = new SQSClient({
    region: 'us-east-1',
    endpoint: 'http://127.0.0.1:4566',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  await client.send(new CreateQueueCommand({
    QueueName: name,
    Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
  }));
  client.destroy();
}
