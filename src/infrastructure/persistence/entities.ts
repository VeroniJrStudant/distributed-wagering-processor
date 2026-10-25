import { BigIntType, EntitySchema, Type } from '@mikro-orm/core';
import { formatScale2 } from '../../domain/money/money.ts';

export class NumericStringType extends Type<string, string> {
  override convertToJSValue(value: unknown): string {
    if (typeof value === 'number') {
      throw new Error('numeric column was decoded as a JavaScript number');
    }
    if (value == null) return '0.00';
    return formatScale2(String(value));
  }

  override convertToDatabaseValue(value: string): string {
    return value;
  }

  override getColumnType(): string {
    return 'numeric(19,2)';
  }
}

export class NullableNumericStringType extends Type<string | null, string | null> {
  override convertToJSValue(value: unknown): string | null {
    if (value == null) return null;
    if (typeof value === 'number') throw new Error('numeric column was decoded as a JavaScript number');
    return formatScale2(String(value));
  }

  override convertToDatabaseValue(value: string | null): string | null {
    return value;
  }

  override getColumnType(): string {
    return 'numeric(19,2)';
  }
}

export class WalletRow {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRow>({
  class: WalletRow,
  name: 'WalletRow',
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    currency: { type: 'string' },
    balance: { type: NumericStringType },
    version: { type: 'integer' },
    createdAt: { type: 'Date', fieldName: 'created_at', columnType: 'timestamptz' },
    updatedAt: { type: 'Date', fieldName: 'updated_at', columnType: 'timestamptz' },
  },
});

export class WagerRow {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId!: string | null;
  status!: string;
  referenceTransactionId!: string | null;
  failureCode!: string | null;
  attemptCount!: number;
  nextAttemptAt!: Date | null;
  observedBalance!: string | null;
  observedCurrency!: string | null;
  correlationId!: string;
  createdAt!: Date;
  processedAt!: Date | null;
}

export const WagerSchema = new EntitySchema<WagerRow>({
  class: WagerRow,
  name: 'WagerRow',
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string', fieldName: 'provider_id' },
    externalTransactionId: { type: 'string', fieldName: 'external_transaction_id' },
    idempotencyKey: { type: 'string', fieldName: 'idempotency_key' },
    payloadHash: { type: 'string', fieldName: 'payload_hash' },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    roundId: { type: 'string', fieldName: 'round_id' },
    gameId: { type: 'string', fieldName: 'game_id' },
    kind: { type: 'string' },
    amount: { type: NumericStringType },
    currency: { type: 'string' },
    referenceExternalTransactionId: { type: 'string', fieldName: 'reference_external_transaction_id', nullable: true },
    status: { type: 'string' },
    referenceTransactionId: { type: 'uuid', fieldName: 'reference_transaction_id', nullable: true },
    failureCode: { type: 'string', fieldName: 'failure_code', nullable: true },
    attemptCount: { type: 'integer', fieldName: 'attempt_count' },
    nextAttemptAt: { type: 'Date', fieldName: 'next_attempt_at', columnType: 'timestamptz', nullable: true },
    observedBalance: { type: NullableNumericStringType, fieldName: 'observed_balance', nullable: true },
    observedCurrency: { type: 'string', fieldName: 'observed_currency', nullable: true },
    correlationId: { type: 'string', fieldName: 'correlation_id' },
    createdAt: { type: 'Date', fieldName: 'created_at', columnType: 'timestamptz' },
    processedAt: { type: 'Date', fieldName: 'processed_at', columnType: 'timestamptz', nullable: true },
  },
});

export class LedgerRow {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
  position?: number;
}

export const LedgerSchema = new EntitySchema<LedgerRow>({
  class: LedgerRow,
  name: 'LedgerRow',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    transactionId: { type: 'uuid', fieldName: 'transaction_id' },
    direction: { type: 'string' },
    amount: { type: NumericStringType },
    currency: { type: 'string' },
    balanceBefore: { type: NumericStringType, fieldName: 'balance_before' },
    balanceAfter: { type: NumericStringType, fieldName: 'balance_after' },
    createdAt: { type: 'Date', fieldName: 'created_at', columnType: 'timestamptz' },
    position: { type: new BigIntType('number'), autoincrement: true, nullable: true },
  },
});

export class InboxRow {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt!: Date | null;
}

export const InboxSchema = new EntitySchema<InboxRow>({
  class: InboxRow,
  name: 'InboxRow',
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', fieldName: 'consumer_name', primary: true },
    messageId: { type: 'string', fieldName: 'message_id', primary: true },
    payloadHash: { type: 'string', fieldName: 'payload_hash' },
    receivedAt: { type: 'Date', fieldName: 'received_at', columnType: 'timestamptz' },
    processedAt: { type: 'Date', fieldName: 'processed_at', columnType: 'timestamptz', nullable: true },
  },
});

export class OutboxRow {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date | null;
  publishedAt!: Date | null;
  lockedBy!: string | null;
  lockedUntil!: Date | null;
}

export const OutboxSchema = new EntitySchema<OutboxRow>({
  class: OutboxRow,
  name: 'OutboxRow',
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'string', fieldName: 'aggregate_id' },
    eventType: { type: 'string', fieldName: 'event_type' },
    payload: { type: 'json' },
    occurredAt: { type: 'Date', fieldName: 'occurred_at', columnType: 'timestamptz' },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'Date', fieldName: 'next_attempt_at', columnType: 'timestamptz', nullable: true },
    publishedAt: { type: 'Date', fieldName: 'published_at', columnType: 'timestamptz', nullable: true },
    lockedBy: { type: 'string', fieldName: 'locked_by', nullable: true },
    lockedUntil: { type: 'Date', fieldName: 'locked_until', columnType: 'timestamptz', nullable: true },
  },
});
