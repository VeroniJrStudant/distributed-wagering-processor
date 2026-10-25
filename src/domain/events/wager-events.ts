import type { MoneyProps } from '../money/money.ts';
import type { LedgerDirection } from '../wallet/ledger-direction.ts';
import type { WalletLedgerEntry } from '../wallet/ledger-entry.ts';
import type { Wallet } from '../wallet/wallet.ts';
import type { WagerTransaction } from '../wager/wager-transaction.ts';
import { IntegrationEvent, type IntegrationEventProps } from './integration-event.ts';

export interface EventContext {
  correlationId: string;
  causationId?: string;
  eventId: string;
  occurredAt: Date;
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(base(wallet.id, ctx, {
      walletId: wallet.id,
      transactionId: entry.transactionId,
      direction: entry.direction,
      money: entry.money.toJSON(),
      balanceBefore: entry.balanceBefore.toJSON(),
      balanceAfter: entry.balanceAfter.toJSON(),
      walletVersion: wallet.version,
    }));
  }
}

export interface WagerTransactionProcessedData {
  transactionId: string;
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  roundId: string;
  gameId: string;
  kind: string;
  status: 'PROCESSED';
  money: MoneyProps;
  walletVersion: number;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(wallet: Wallet, wager: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed(base(wallet.id, ctx, {
      transactionId: wager.id,
      walletId: wallet.id,
      playerId: wager.playerId,
      providerId: wager.providerId,
      externalTransactionId: wager.externalTransactionId,
      roundId: wager.roundId,
      gameId: wager.gameId,
      kind: wager.kind,
      status: 'PROCESSED',
      money: wager.money.toJSON(),
      walletVersion: wallet.version,
    }));
  }
}

export interface WagerTransactionRejectedData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  kind: string;
  failureCode: string;
  money: MoneyProps;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(wager: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected(base(wager.walletId, ctx, {
      transactionId: wager.id,
      walletId: wager.walletId,
      providerId: wager.providerId,
      externalTransactionId: wager.externalTransactionId,
      kind: wager.kind,
      failureCode: wager.failureCode ?? 'UNKNOWN',
      money: wager.money.toJSON(),
    }));
  }
}

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  referenceExternalTransactionId: string;
  kind: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(wager: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(base(wager.walletId, ctx, {
      transactionId: wager.id,
      walletId: wager.walletId,
      providerId: wager.providerId,
      externalTransactionId: wager.externalTransactionId,
      referenceExternalTransactionId: wager.referenceExternalTransactionId ?? '',
      kind: wager.kind,
    }));
  }
}

function base<T>(aggregateId: string, ctx: EventContext, data: T): IntegrationEventProps<T> {
  return {
    eventId: ctx.eventId,
    aggregateId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    occurredAt: ctx.occurredAt,
    data,
  };
}
