import { DomainError } from '../../domain/errors.ts';
import { InboxMessage } from '../../domain/inbox/inbox-message.ts';
import { Money } from '../../domain/money/money.ts';
import { OutboxMessage } from '../../domain/outbox/outbox-message.ts';
import { LedgerDirection } from '../../domain/wallet/ledger-direction.ts';
import { WalletLedgerEntry } from '../../domain/wallet/ledger-entry.ts';
import { Wallet } from '../../domain/wallet/wallet.ts';
import { FailureCode } from '../../domain/wager/failure-code.ts';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager/wager-transaction.ts';
import { InboxRow, LedgerRow, OutboxRow, WagerRow, type WalletRow } from './entities.ts';

export function toWallet(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.playerId,
    currency: row.currency,
    balance: Money.from({ amount: row.balance, currency: row.currency }),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export function assignWallet(row: WalletRow, wallet: Wallet): void {
  row.id = wallet.id;
  row.playerId = wallet.playerId;
  row.currency = wallet.currency;
  row.balance = wallet.balance.toJSON().amount;
  row.version = wallet.version;
  row.createdAt = wallet.createdAt;
  row.updatedAt = wallet.updatedAt;
}

export function toWager(row: WagerRow): WagerTransaction {
  const kind = asEnum(row.kind, WagerTransactionKind, 'kind');
  const status = asEnum(row.status, WagerTransactionStatus, 'status');
  const observed =
    row.observedBalance && row.observedCurrency
      ? Money.from({ amount: row.observedBalance, currency: row.observedCurrency })
      : undefined;
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    walletId: row.walletId,
    playerId: row.playerId,
    roundId: row.roundId,
    gameId: row.gameId,
    kind,
    money: Money.from({ amount: row.amount, currency: row.currency }),
    referenceExternalTransactionId: row.referenceExternalTransactionId ?? undefined,
    correlationId: row.correlationId,
    createdAt: row.createdAt,
    status,
    referenceTransactionId: row.referenceTransactionId ?? undefined,
    failureCode: row.failureCode ? asEnum(row.failureCode, FailureCode, 'failureCode') : undefined,
    processedAt: row.processedAt ?? undefined,
    attemptCount: row.attemptCount,
    nextAttemptAt: row.nextAttemptAt ?? undefined,
    observedBalance: observed,
  });
}

export function assignWager(row: WagerRow, wager: WagerTransaction): void {
  row.id = wager.id;
  row.providerId = wager.providerId;
  row.externalTransactionId = wager.externalTransactionId;
  row.idempotencyKey = wager.idempotencyKey;
  row.payloadHash = wager.payloadHash;
  row.walletId = wager.walletId;
  row.playerId = wager.playerId;
  row.roundId = wager.roundId;
  row.gameId = wager.gameId;
  row.kind = wager.kind;
  row.amount = wager.money.toJSON().amount;
  row.currency = wager.money.currency;
  row.referenceExternalTransactionId = wager.referenceExternalTransactionId ?? null;
  row.status = wager.status;
  row.referenceTransactionId = wager.referenceTransactionId ?? null;
  row.failureCode = wager.failureCode ?? null;
  row.attemptCount = wager.attemptCount;
  row.nextAttemptAt = wager.nextAttemptAt ?? null;
  row.observedBalance = wager.observedBalance?.toJSON().amount ?? null;
  row.observedCurrency = wager.observedBalance?.currency ?? null;
  row.correlationId = wager.correlationId;
  row.createdAt = wager.createdAt;
  row.processedAt = wager.processedAt ?? null;
}

export function toLedger(row: LedgerRow): WalletLedgerEntry {
  const direction = asEnum(row.direction, LedgerDirection, 'direction');
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.walletId,
    transactionId: row.transactionId,
    direction,
    money: Money.from({ amount: row.amount, currency: row.currency }),
    balanceBefore: Money.from({ amount: row.balanceBefore, currency: row.currency }),
    balanceAfter: Money.from({ amount: row.balanceAfter, currency: row.currency }),
    createdAt: row.createdAt,
    position: row.position === undefined || row.position === null ? undefined : Number(row.position),
  });
}

export function newLedgerRow(entry: WalletLedgerEntry): LedgerRow {
  const row = new LedgerRow();
  row.id = entry.id;
  row.walletId = entry.walletId;
  row.transactionId = entry.transactionId;
  row.direction = entry.direction;
  row.amount = entry.money.toJSON().amount;
  row.currency = entry.money.currency;
  row.balanceBefore = entry.balanceBefore.toJSON().amount;
  row.balanceAfter = entry.balanceAfter.toJSON().amount;
  row.createdAt = entry.createdAt;
  return row;
}

export function toInbox(row: InboxRow): InboxMessage {
  return InboxMessage.rehydrate({
    messageId: row.messageId,
    consumerName: row.consumerName,
    payloadHash: row.payloadHash,
    receivedAt: row.receivedAt,
    processedAt: row.processedAt ?? undefined,
  });
}

export function assignInbox(row: InboxRow, message: InboxMessage): void {
  row.consumerName = message.consumerName;
  row.messageId = message.messageId;
  row.payloadHash = message.payloadHash;
  row.receivedAt = message.receivedAt;
  row.processedAt = message.processedAt ?? null;
}

export function newOutboxRow(message: OutboxMessage): OutboxRow {
  const row = new OutboxRow();
  row.id = message.id;
  row.aggregateId = message.aggregateId;
  row.eventType = message.eventType;
  row.payload = { ...message.payload };
  row.occurredAt = message.occurredAt;
  row.attempts = message.attempts;
  row.nextAttemptAt = message.nextAttemptAt ?? null;
  row.publishedAt = message.publishedAt ?? null;
  row.lockedBy = null;
  row.lockedUntil = null;
  return row;
}

function asEnum<T extends Record<string, string>>(value: string, enumeration: T, label: string): T[keyof T] {
  if (Object.values(enumeration).includes(value)) return value as T[keyof T];
  throw new DomainError('CORRUPT_STATE', `Unknown ${label} value`);
}
