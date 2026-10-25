import { DomainError } from '../errors.ts';
import { Money } from '../money/money.ts';
import { LedgerDirection } from './ledger-direction.ts';

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export interface LedgerEntryState extends CreateLedgerEntryProps {
  position?: number;
}

/** Immutable ledger line. There is no transition method on purpose. */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
    public readonly position?: number,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    assertBalanced(props);
    if (!props.money.isPositive()) {
      throw new DomainError('LEDGER_AMOUNT', 'Ledger amount must be positive');
    }
    return new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt,
    );
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
      state.position,
    );
  }

  isBalanced(): boolean {
    return expectedAfter(this).equals(this.balanceAfter);
  }
}

function assertBalanced(props: CreateLedgerEntryProps): void {
  if (!props.money.currency || props.balanceBefore.currency !== props.money.currency) {
    throw new DomainError('CURRENCY_MISMATCH', 'Ledger currencies must match');
  }
  if (!expectedAfter(props).equals(props.balanceAfter)) {
    throw new DomainError('LEDGER_UNBALANCED', 'balanceBefore ± amount must equal balanceAfter');
  }
}

function expectedAfter(props: {
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
}): Money {
  return props.direction === LedgerDirection.Credit
    ? props.balanceBefore.add(props.money)
    : props.balanceBefore.subtract(props.money);
}
