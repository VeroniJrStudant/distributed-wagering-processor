import type { InboxMessage } from '../domain/inbox/inbox-message.ts';
import type { OutboxMessage } from '../domain/outbox/outbox-message.ts';
import type { WalletLedgerEntry } from '../domain/wallet/ledger-entry.ts';
import type { Wallet } from '../domain/wallet/wallet.ts';
import type { WagerTransaction } from '../domain/wager/wager-transaction.ts';

export interface WalletStore {
  lockById(id: string): Promise<Wallet | null>;
  findByPlayerCurrency(playerId: string, currency: string): Promise<Wallet | null>;
  insert(wallet: Wallet): void;
  save(wallet: Wallet): void;
}

export interface WagerStore {
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | null>;
  findByExternal(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  hasProcessedReversal(providerId: string, referenceExternalTransactionId: string): Promise<boolean>;
  findPendingReferencing(providerId: string, externalTransactionId: string): Promise<WagerTransaction[]>;
  save(wager: WagerTransaction): void;
}

export interface LedgerStore {
  add(entry: WalletLedgerEntry): void;
}

export interface InboxStore {
  find(consumerName: string, messageId: string): Promise<InboxMessage | null>;
  save(message: InboxMessage): void;
}

export interface OutboxStore {
  add(message: OutboxMessage): void;
}

export interface TxRepos {
  wallets: WalletStore;
  wagers: WagerStore;
  ledger: LedgerStore;
  inbox: InboxStore;
  outbox: OutboxStore;
  flush(): Promise<void>;
}

export interface UnitOfWork {
  run<T>(work: (repos: TxRepos) => Promise<T>): Promise<T>;
}

export interface AppLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface MetricsPort {
  increment(name: string, labels?: Record<string, string>, value?: number): void;
  setGauge(name: string, value: number, labels?: Record<string, string>): void;
  observe(name: string, value: number, labels?: Record<string, string>): void;
}

export interface ProviderIdentityPort {
  assertCanSubmit(providerId: string): void;
}

export interface ReadModel {
  wallet(id: string): Promise<Wallet | null>;
  ledger(
    walletId: string,
    afterPosition: number | undefined,
    limit: number,
  ): Promise<{ entries: WalletLedgerEntry[]; hasMore: boolean }>;
  transaction(id: string): Promise<WagerTransaction | null>;
  transactionByExternal(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  ledgerSum(walletId: string): Promise<{ balance: string; entries: number } | null>;
  duePendingReferences(limit: number, now: Date): Promise<Array<{ id: string; walletId: string }>>;
}
