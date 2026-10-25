import { Inject, Injectable } from '@nestjs/common';
import { ApplicationError } from './application-error.ts';
import type { MoneyProps } from '../domain/money/money.ts';
import { Money } from '../domain/money/money.ts';
import type { AppLogger, MetricsPort, ReadModel } from './ports.ts';
import { APP_LOGGER, APP_METRICS, READ_MODEL } from './tokens.ts';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

@Injectable()
export class ReconcileWallet {
  constructor(
    @Inject(READ_MODEL) private readonly reads: ReadModel,
    @Inject(APP_METRICS) private readonly metrics: MetricsPort,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const wallet = await this.reads.wallet(walletId);
    if (!wallet) throw new ApplicationError('WALLET_NOT_FOUND', 'Wallet was not found', 404);
    const sum = await this.reads.ledgerSum(walletId);
    if (!sum) throw new ApplicationError('WALLET_NOT_FOUND', 'Wallet was not found', 404);
    const calculated = Money.exact(sum.balance, wallet.currency);
    const consistent = wallet.balance.equals(calculated);
    this.metrics.increment('reconciliation_checks_total');
    if (!consistent) {
      this.metrics.increment('reconciliation_divergences_total');
      this.logger.warn('wallet reconciliation diverged', { walletId, checkedEntries: sum.entries });
    }
    return {
      walletId,
      storedBalance: wallet.balance.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: wallet.balance.subtract(calculated).toJSON(),
      consistent,
      checkedEntries: sum.entries,
    };
  }
}
