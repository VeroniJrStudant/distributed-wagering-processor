import { Inject, Injectable } from '@nestjs/common';
import { ApplicationError } from './application-error.ts';
import type { MoneyProps } from '../domain/money/money.ts';
import type { WagerTransaction } from '../domain/wager/wager-transaction.ts';
import type { ReadModel } from './ports.ts';
import { READ_MODEL } from './tokens.ts';

export function encodeCursor(position: number): string {
  return Buffer.from(JSON.stringify({ p: position }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): number {
  try {
    const json = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { p?: unknown };
    if (typeof json.p !== 'number' || !Number.isSafeInteger(json.p) || json.p < 1) throw new Error('bad cursor');
    return json.p;
  } catch {
    throw new ApplicationError('INVALID_CURSOR', 'cursor is invalid', 400);
  }
}

@Injectable()
export class WalletQueries {
  constructor(@Inject(READ_MODEL) private readonly reads: ReadModel) {}

  async getWallet(walletId: string) {
    const wallet = await this.reads.wallet(walletId);
    if (!wallet) throw new ApplicationError('WALLET_NOT_FOUND', 'Wallet was not found', 404);
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }

  async getLedger(walletId: string, cursor: string | undefined, limit: number) {
    const wallet = await this.reads.wallet(walletId);
    if (!wallet) throw new ApplicationError('WALLET_NOT_FOUND', 'Wallet was not found', 404);
    const page = await this.reads.ledger(walletId, cursor ? decodeCursor(cursor) : undefined, limit);
    const last = page.entries.at(-1);
    return {
      entries: page.entries.map((entry) => ({
        id: entry.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: page.hasMore && last?.position ? encodeCursor(last.position) : null,
    };
  }

  async getTransaction(transactionId: string) {
    const wager = await this.reads.transaction(transactionId);
    if (!wager) throw new ApplicationError('TRANSACTION_NOT_FOUND', 'Transaction was not found', 404);
    return presentTransaction(wager);
  }

  async getByExternal(providerId: string, externalTransactionId: string) {
    const wager = await this.reads.transactionByExternal(providerId, externalTransactionId);
    if (!wager) throw new ApplicationError('TRANSACTION_NOT_FOUND', 'Transaction was not found', 404);
    return presentTransaction(wager);
  }
}

function presentTransaction(wager: WagerTransaction): {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  status: string;
  money: MoneyProps;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  failureCode: string | null;
  balance: MoneyProps | null;
  createdAt: string;
  processedAt: string | null;
} {
  return {
    id: wager.id,
    providerId: wager.providerId,
    externalTransactionId: wager.externalTransactionId,
    idempotencyKey: wager.idempotencyKey,
    walletId: wager.walletId,
    playerId: wager.playerId,
    roundId: wager.roundId,
    gameId: wager.gameId,
    kind: wager.kind,
    status: wager.status,
    money: wager.money.toJSON(),
    referenceExternalTransactionId: wager.referenceExternalTransactionId ?? null,
    referenceTransactionId: wager.referenceTransactionId ?? null,
    failureCode: wager.failureCode ?? null,
    balance: wager.observedBalance?.toJSON() ?? null,
    createdAt: wager.createdAt.toISOString(),
    processedAt: wager.processedAt?.toISOString() ?? null,
  };
}
