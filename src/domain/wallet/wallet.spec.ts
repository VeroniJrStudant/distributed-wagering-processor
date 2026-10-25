import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InsufficientFundsError } from '../errors.ts';
import { Money } from '../money/money.ts';
import { WalletLedgerEntry } from './ledger-entry.ts';
import { LedgerDirection } from './ledger-direction.ts';
import { Wallet } from './wallet.ts';

const now = new Date('2026-07-29T15:00:00.000Z');

function wallet(amount = '100.00'): Wallet {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: Money.from({ amount, currency: 'BRL' }),
    now,
  });
}

describe('Wallet', () => {
  test('opens at version 1 with the initial balance', () => {
    const opened = wallet('1000.00');
    expect(opened.version).toBe(1);
    expect(opened.balance.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
  });

  test('rejects a debit that would go negative and does not change state', () => {
    const account = wallet('20.00');
    expect(() => account.debit(Money.from({ amount: '80.00', currency: 'BRL' }), now)).toThrow(
      InsufficientFundsError,
    );
    expect(account.balance.toJSON().amount).toBe('20.00');
    expect(account.version).toBe(1);
  });

  test('increments version only when the balance changes', () => {
    const account = wallet('100.00');
    account.debit(Money.from({ amount: '80.00', currency: 'BRL' }), now);
    expect(account.balance.toJSON().amount).toBe('20.00');
    expect(account.version).toBe(2);
    account.credit(Money.from({ amount: '5.00', currency: 'BRL' }), now);
    expect(account.balance.toJSON().amount).toBe('25.00');
    expect(account.version).toBe(3);
  });

  test('rejects a movement in another currency', () => {
    const account = wallet();
    expect(() => account.debit(Money.from({ amount: '1.00', currency: 'USD' }), now)).toThrow(
      CurrencyMismatchError,
    );
  });

  test('allows spending the exact balance', () => {
    const account = wallet('80.00');
    account.debit(Money.from({ amount: '80.00', currency: 'BRL' }), now);
    expect(account.balance.isZero()).toBe(true);
  });
});

describe('WalletLedgerEntry', () => {
  test('checks double-entry arithmetic and then stays immutable', () => {
    const entry = WalletLedgerEntry.create({
      id: 'entry-1',
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      direction: LedgerDirection.Debit,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '75.00', currency: 'BRL' }),
      createdAt: now,
    });
    expect(entry.isBalanced()).toBe(true);
    expect(Object.isFrozen(entry.money)).toBe(false);
    expect(entry.balanceAfter.toJSON().amount).toBe('75.00');
  });

  test('rejects an unbalanced line', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'entry-1',
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: LedgerDirection.Credit,
        money: Money.from({ amount: '10.00', currency: 'BRL' }),
        balanceBefore: Money.from({ amount: '10.00', currency: 'BRL' }),
        balanceAfter: Money.from({ amount: '10.00', currency: 'BRL' }),
        createdAt: now,
      }),
    ).toThrow('balanceBefore');
  });
});
