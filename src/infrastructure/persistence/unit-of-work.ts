import { EntityManager, LockMode, type MikroORM } from '@mikro-orm/core';
import { Inject, Injectable } from '@nestjs/common';
import { ORM } from '../../config.ts';
import { InboxMessage } from '../../domain/inbox/inbox-message.ts';
import { OutboxMessage } from '../../domain/outbox/outbox-message.ts';
import type { WalletLedgerEntry } from '../../domain/wallet/ledger-entry.ts';
import type { Wallet } from '../../domain/wallet/wallet.ts';
import { WagerTransactionKind, WagerTransactionStatus, type WagerTransaction } from '../../domain/wager/wager-transaction.ts';
import type { InboxStore, LedgerStore, OutboxStore, TxRepos, UnitOfWork, WagerStore, WalletStore } from '../../application/ports.ts';
import { InboxRow, LedgerRow, OutboxRow, WagerRow, WalletRow } from './entities.ts';
import { assignInbox, assignWager, assignWallet, newLedgerRow, newOutboxRow, toInbox, toWager, toWallet } from './mapping.ts';

@Injectable()
export class SqlUnitOfWork implements UnitOfWork {
  constructor(
    @Inject(ORM) private readonly orm: MikroORM,
    @Inject(EntityManager) private readonly em: EntityManager,
  ) {}

  async run<T>(work: (repos: TxRepos) => Promise<T>): Promise<T> {
    if (!this.orm.isConnected()) await this.orm.connect();
    const em = this.em.fork();
    return em.transactional(async (tx) => work(new MikroTx(tx)));
  }
}

class MikroTx implements TxRepos {
  readonly wallets: WalletStore;
  readonly wagers: WagerStore;
  readonly ledger: LedgerStore;
  readonly inbox: InboxStore;
  readonly outbox: OutboxStore;

  constructor(private readonly em: EntityManager) {
    this.wallets = new WalletRepo(em);
    this.wagers = new WagerRepo(em);
    this.ledger = new LedgerRepo(em);
    this.inbox = new InboxRepo(em);
    this.outbox = new OutboxRepo(em);
  }

  async flush(): Promise<void> {
    await this.em.flush();
  }
}

class WalletRepo implements WalletStore {
  private readonly tracked = new Map<string, WalletRow>();

  constructor(private readonly em: EntityManager) {}

  async lockById(id: string): Promise<Wallet | null> {
    const row = await this.em.findOne(WalletRow, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    if (!row) return null;
    this.tracked.set(row.id, row);
    return toWallet(row);
  }

  async findByPlayerCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    const row = await this.em.findOne(WalletRow, { playerId, currency });
    return row ? toWallet(row) : null;
  }

  insert(wallet: Wallet): void {
    const row = new WalletRow();
    assignWallet(row, wallet);
    this.em.persist(row);
    this.tracked.set(wallet.id, row);
  }

  save(wallet: Wallet): void {
    const row = this.tracked.get(wallet.id);
    if (!row) throw new Error(`wallet ${wallet.id} is not locked in this transaction`);
    assignWallet(row, wallet);
  }
}

class WagerRepo implements WagerStore {
  private readonly tracked = new Map<string, WagerRow>();

  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | null> {
    return this.remember(await this.em.findOne(WagerRow, { id }));
  }

  async findByIdempotencyKey(key: string): Promise<WagerTransaction | null> {
    return this.remember(await this.em.findOne(WagerRow, { idempotencyKey: key }));
  }

  async findByExternal(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    return this.remember(await this.em.findOne(WagerRow, { providerId, externalTransactionId }));
  }

  async hasProcessedReversal(providerId: string, referenceExternalTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerRow, {
      providerId,
      referenceExternalTransactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  async findPendingReferencing(providerId: string, externalTransactionId: string): Promise<WagerTransaction[]> {
    const rows = await this.em.find(WagerRow, {
      providerId,
      referenceExternalTransactionId: externalTransactionId,
      status: WagerTransactionStatus.PendingReference,
    });
    return rows.map((row) => this.remember(row)!);
  }

  save(wager: WagerTransaction): void {
    const existing = this.tracked.get(wager.id);
    if (existing) {
      assignWager(existing, wager);
      return;
    }
    const row = new WagerRow();
    assignWager(row, wager);
    this.em.persist(row);
    this.tracked.set(wager.id, row);
  }

  private remember(row: WagerRow | null): WagerTransaction | null {
    if (!row) return null;
    this.tracked.set(row.id, row);
    return toWager(row);
  }
}

class LedgerRepo implements LedgerStore {
  constructor(private readonly em: EntityManager) {}

  add(entry: WalletLedgerEntry): void {
    this.em.persist(newLedgerRow(entry));
  }
}

class InboxRepo implements InboxStore {
  private readonly tracked = new Map<string, InboxRow>();

  constructor(private readonly em: EntityManager) {}

  async find(consumerName: string, messageId: string): Promise<InboxMessage | null> {
    const row = await this.em.findOne(InboxRow, { consumerName, messageId });
    if (!row) return null;
    this.tracked.set(this.key(consumerName, messageId), row);
    return toInbox(row);
  }

  save(message: InboxMessage): void {
    const key = this.key(message.consumerName, message.messageId);
    const existing = this.tracked.get(key);
    if (existing) {
      assignInbox(existing, message);
      return;
    }
    const row = new InboxRow();
    assignInbox(row, message);
    this.em.persist(row);
    this.tracked.set(key, row);
  }

  private key(consumerName: string, messageId: string): string {
    return `${consumerName}\u0000${messageId}`;
  }
}

class OutboxRepo implements OutboxStore {
  constructor(private readonly em: EntityManager) {}

  add(message: OutboxMessage): void {
    this.em.persist(newOutboxRow(message));
  }
}
