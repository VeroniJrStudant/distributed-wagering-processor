import { EntityManager, type MikroORM } from '@mikro-orm/core';
import { Inject, Injectable } from '@nestjs/common';
import { ORM } from '../../config.ts';
import type { WalletLedgerEntry } from '../../domain/wallet/ledger-entry.ts';
import type { Wallet } from '../../domain/wallet/wallet.ts';
import type { WagerTransaction } from '../../domain/wager/wager-transaction.ts';
import type { ReadModel } from '../../application/ports.ts';
import { LedgerRow, WagerRow, WalletRow } from './entities.ts';
import { toLedger, toWager, toWallet } from './mapping.ts';

@Injectable()
export class MikroReadModel implements ReadModel {
  constructor(
    @Inject(ORM) private readonly orm: MikroORM,
    @Inject(EntityManager) private readonly em: EntityManager,
  ) {}

  async wallet(id: string): Promise<Wallet | null> {
    const em = await this.fork();
    const row = await em.findOne(WalletRow, { id });
    return row ? toWallet(row) : null;
  }

  async ledger(
    walletId: string,
    afterPosition: number | undefined,
    limit: number,
  ): Promise<{ entries: WalletLedgerEntry[]; hasMore: boolean }> {
    const em = await this.fork();
    const where = afterPosition === undefined ? { walletId } : { walletId, position: { $gt: afterPosition } };
    const rows = await em.find(LedgerRow, where, { orderBy: { position: 'asc' }, limit: limit + 1 });
    const hasMore = rows.length > limit;
    return { entries: rows.slice(0, limit).map((row) => toLedger(row)), hasMore };
  }

  async transaction(id: string): Promise<WagerTransaction | null> {
    const em = await this.fork();
    const row = await em.findOne(WagerRow, { id });
    return row ? toWager(row) : null;
  }

  async transactionByExternal(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    const em = await this.fork();
    const row = await em.findOne(WagerRow, { providerId, externalTransactionId });
    return row ? toWager(row) : null;
  }

  async ledgerSum(walletId: string): Promise<{ balance: string; entries: number } | null> {
    const em = await this.fork();
    const wallet = await em.findOne(WalletRow, { id: walletId }, { fields: ['id'] });
    if (!wallet) return null;
    const rows = await em.getConnection().execute<{ balance: string; entries: number | string }[]>(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)::text AS balance,
              COUNT(*)::int AS entries
       FROM wallet_ledger_entries
       WHERE wallet_id = ?`,
      [walletId],
    );
    const row = rows[0];
    if (!row) return { balance: '0.00', entries: 0 };
    const entries = typeof row.entries === 'number' ? row.entries : Number(row.entries);
    if (!Number.isSafeInteger(entries)) throw new Error('invalid ledger count');
    return { balance: row.balance, entries };
  }

  async duePendingReferences(limit: number, now: Date): Promise<Array<{ id: string; walletId: string }>> {
    const em = await this.fork();
    const rows = await em.getConnection().execute<Array<{ id: string; wallet_id: string }>>(
      `SELECT id, wallet_id
       FROM wager_transactions
       WHERE status = 'PENDING_REFERENCE'
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at
       LIMIT ?`,
      [now, limit],
    );
    return rows.map((row: { id: string; wallet_id: string }) => ({ id: row.id, walletId: row.wallet_id }));
  }

  private async fork(): Promise<EntityManager> {
    if (!this.orm.isConnected()) await this.orm.connect();
    return this.em.fork();
  }
}
