import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from '../errors.ts';

const INPUT_AMOUNT = /^(0|[1-9]\d*)\.\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;

export interface MoneyProps {
  amount: string;
  currency: string;
}

/**
 * Immutable money. Inputs are decimal strings with scale 2.
 * Arithmetic uses decimal.js so values such as 0.10 + 0.20 stay exact.
 * A negative result can appear only as a calculated difference, never as an input.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidMoneyError('money must be an object');
    }
    if (typeof (props as { amount?: unknown }).amount !== 'string') {
      throw new InvalidMoneyError('amount must be a decimal string');
    }
    if (typeof props.currency !== 'string') {
      throw new InvalidMoneyError('currency must be a string');
    }
    if (!INPUT_AMOUNT.test(props.amount)) {
      throw new InvalidMoneyError(
        'amount must be a non-negative decimal string with exactly 2 decimal places',
      );
    }
    if (!CURRENCY.test(props.currency)) {
      throw new InvalidMoneyError('currency must be an ISO-4217 code');
    }
    return Money.wrap(new Decimal(props.amount), props.currency);
  }

  /** Rebuilds an exact scale-2 value, including a signed difference. */
  static exact(amount: string, currency: string): Money {
    if (!CURRENCY.test(currency)) throw new InvalidMoneyError('currency must be an ISO-4217 code');
    return Money.wrap(new Decimal(formatScale2(amount)), currency);
  }

  static zero(currency: string): Money {
    if (!CURRENCY.test(currency)) throw new InvalidMoneyError('currency must be an ISO-4217 code');
    return Money.wrap(new Decimal(0), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.wrap(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.wrap(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.wrap(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(2), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) throw new CurrencyMismatchError();
  }

  private static wrap(value: Decimal, currency: string): Money {
    const scaled = value.toDecimalPlaces(2);
    if (!scaled.equals(value)) throw new InvalidMoneyError('money arithmetic exceeded scale 2');
    return new Money(scaled, currency);
  }
}

/** Normalizes a database numeric to scale 2 without binary floating point. */
export function formatScale2(value: string): string {
  const trimmed = value.trim();
  const negative = trimmed.startsWith('-');
  const raw = negative ? trimmed.slice(1) : trimmed;
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new InvalidMoneyError('invalid decimal value');
  }
  const [ints, frac = ''] = raw.split('.');
  if (/[1-9]/.test(frac.slice(2))) {
    throw new InvalidMoneyError('decimal scale exceeds 2');
  }
  const cents = frac.padEnd(2, '0').slice(0, 2);
  return `${negative ? '-' : ''}${BigInt(ints!).toString()}.${cents}`;
}
