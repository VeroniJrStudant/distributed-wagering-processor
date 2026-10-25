import { Inject, Injectable } from '@nestjs/common';
import { ApplicationError } from './application-error.ts';
import type { Clock, IdGenerator } from '../domain/ids.ts';
import { SystemClock, UuidGenerator } from '../domain/ids.ts';
import type { MoneyProps } from '../domain/money/money.ts';
import { Money } from '../domain/money/money.ts';
import { OutboxMessage } from '../domain/outbox/outbox-message.ts';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../domain/events/wager-events.ts';
import { LedgerDirection } from '../domain/wallet/ledger-direction.ts';
import { WalletLedgerEntry } from '../domain/wallet/ledger-entry.ts';
import { Wallet } from '../domain/wallet/wallet.ts';
import { WagerTransaction } from '../domain/wager/wager-transaction.ts';
import { hashBusinessPayload } from './payload-hash.ts';
import type { AppLogger, MetricsPort, UnitOfWork } from './ports.ts';
import { isUniqueViolation } from './sql-state.ts';
import { APP_LOGGER, APP_METRICS, UNIT_OF_WORK } from './tokens.ts';

export interface OpenWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

@Injectable()
export class OpenWallet {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(SystemClock) private readonly clock: Clock,
    @Inject(UuidGenerator) private readonly ids: IdGenerator,
    @Inject(APP_METRICS) private readonly metrics: MetricsPort,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
  ) {}

  async execute(input: { playerId: string; initialBalance: MoneyProps }, correlationId: string): Promise<OpenWalletResult> {
    const money = Money.from(input.initialBalance);
    const now = this.clock.now();
    try {
      const result = await this.uow.run((repos) => this.open(repos, input.playerId, money, correlationId, now));
      this.logger.info('wallet opened', { walletId: result.id, playerId: result.playerId, correlationId });
      return result;
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      if (isUniqueViolation(error)) {
        throw new ApplicationError('WALLET_ALREADY_EXISTS', 'A wallet already exists for this player and currency', 409);
      }
      throw error;
    }
  }

  private async open(
    repos: Parameters<Parameters<UnitOfWork['run']>[0]>[0],
    playerId: string,
    money: Money,
    correlationId: string,
    now: Date,
  ): Promise<OpenWalletResult> {
    const existing = await repos.wallets.findByPlayerCurrency(playerId, money.currency);
    if (existing) {
      throw new ApplicationError('WALLET_ALREADY_EXISTS', 'A wallet already exists for this player and currency', 409);
    }
    const wallet = Wallet.open({ id: this.ids.uuid(), playerId, initialBalance: money, now });
    repos.wallets.insert(wallet);
    await repos.flush();
    if (!money.isZero()) {
      const external = `opening:${wallet.id}`;
      const opening = WagerTransaction.createOpening({
        id: this.ids.uuid(),
        walletId: wallet.id,
        playerId,
        money,
        payloadHash: hashBusinessPayload({
          providerId: 'internal',
          externalTransactionId: external,
          playerId,
          walletId: wallet.id,
          roundId: 'opening',
          gameId: 'opening',
          kind: 'OPENING',
          money: money.toJSON(),
        }),
        correlationId,
        createdAt: now,
      });
      opening.markProcessed(undefined, now);
      opening.snapshotBalance(money);
      const entry = WalletLedgerEntry.create({
        id: this.ids.uuid(),
        walletId: wallet.id,
        transactionId: opening.id,
        direction: LedgerDirection.Credit,
        money,
        balanceBefore: Money.zero(money.currency),
        balanceAfter: money,
        createdAt: now,
      });
      const processed = this.event(correlationId, opening.id, now);
      const changed = this.event(correlationId, opening.id, now);
      repos.wagers.save(opening);
      repos.outbox.add(OutboxMessage.enqueue(WagerTransactionProcessed.from(wallet, opening, processed)));
      repos.outbox.add(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, changed)));
      await repos.flush();
      repos.ledger.add(entry);
      await repos.flush();
      this.metrics.increment('wager_transactions_total', { status: 'PROCESSED', kind: 'OPENING' });
    }
    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
  }

  private event(correlationId: string, causationId: string, occurredAt: Date) {
    return { eventId: this.ids.uuid(), correlationId, causationId, occurredAt };
  }
}
