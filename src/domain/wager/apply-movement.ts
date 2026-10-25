import { DomainError, InsufficientFundsError } from '../errors.ts';
import { WalletLedgerEntry } from '../wallet/ledger-entry.ts';
import { LedgerDirection } from '../wallet/ledger-direction.ts';
import { Wallet } from '../wallet/wallet.ts';
import { FailureCode } from './failure-code.ts';
import { WagerTransaction, WagerTransactionKind } from './wager-transaction.ts';

export function applyMovement(input: {
  wallet: Wallet;
  wager: WagerTransaction;
  reference?: WagerTransaction;
  entryId: string;
  at: Date;
}): WalletLedgerEntry | undefined {
  if (!input.wager.affectsBalance()) return undefined;
  if (!input.wager.money.isPositive()) {
    throw new DomainError(FailureCode.InvalidAmount, 'amount must be positive');
  }
  const direction = input.wager.ledgerDirectionFor(input.reference);
  const balanceBefore = input.wallet.balance;
  try {
    if (direction === LedgerDirection.Debit) input.wallet.debit(input.wager.money, input.at);
    else input.wallet.credit(input.wager.money, input.at);
  } catch (error) {
    if (error instanceof InsufficientFundsError) {
      throw new InsufficientFundsError(input.wager.kind === WagerTransactionKind.Rollback);
    }
    throw error;
  }
  return WalletLedgerEntry.create({
    id: input.entryId,
    walletId: input.wallet.id,
    transactionId: input.wager.id,
    direction,
    money: input.wager.money,
    balanceBefore,
    balanceAfter: input.wallet.balance,
    createdAt: input.at,
  });
}
