import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../errors.ts';
import { Money } from './money.ts';

describe('Money', () => {
  test('adds scale-2 amounts without binary rounding', () => {
    const total = Money.from({ amount: '0.10', currency: 'BRL' }).add(
      Money.from({ amount: '0.20', currency: 'BRL' }),
    );
    expect(total.toJSON()).toEqual({ amount: '0.30', currency: 'BRL' });
  });

  test('subtracts and compares', () => {
    const balance = Money.from({ amount: '100.00', currency: 'BRL' });
    const bet = Money.from({ amount: '80.00', currency: 'BRL' });
    expect(balance.subtract(bet).toJSON().amount).toBe('20.00');
    expect(bet.isLessThan(balance)).toBe(true);
    expect(balance.equals(Money.from({ amount: '100.00', currency: 'BRL' }))).toBe(true);
  });

  test('rejects invalid inputs', () => {
    const invalid = ['25', '25.0', '25.001', '01.00', '', '1e2', 'NaN', 'Infinity', '-1.00', '25.00 '];
    for (const amount of invalid) {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
    }
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: '25.00', currency: 'brl' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: '25.00', currency: 'BRLL' })).toThrow(InvalidMoneyError);
  });

  test('rejects mixed currencies', () => {
    const brl = Money.from({ amount: '1.00', currency: 'BRL' });
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  test('zero and negation stay at scale 2', () => {
    const zero = Money.zero('BRL');
    expect(zero.isZero()).toBe(true);
    expect(zero.toJSON().amount).toBe('0.00');
    expect(Money.from({ amount: '2.50', currency: 'BRL' }).negate().toJSON().amount).toBe('-2.50');
  });

  test('is immutable across operations', () => {
    const original = Money.from({ amount: '10.00', currency: 'BRL' });
    original.add(Money.from({ amount: '1.00', currency: 'BRL' }));
    expect(original.toJSON().amount).toBe('10.00');
  });
});
