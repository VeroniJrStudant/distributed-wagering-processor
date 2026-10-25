import { CurrencyMismatchError, InsufficientFundsError } from '../errors.ts';
import { Money } from '../money/money.ts';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Version starts at 1. The opening balance is the creation state, so it does
   * not count as a later balance change. The HTTP example returns version 1.
   */
  static open(props: { id: string; playerId: string; initialBalance: Money; now: Date }): Wallet {
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.now,
      props.now,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(amount: Money, at: Date): void {
    this.assertSameCurrency(amount);
    if (this._balance.isLessThan(amount)) throw new InsufficientFundsError(false);
    this._balance = this._balance.subtract(amount);
    this.touch(at);
  }

  credit(amount: Money, at: Date): void {
    this.assertSameCurrency(amount);
    this._balance = this._balance.add(amount);
    this.touch(at);
  }

  private touch(at: Date): void {
    this._version += 1;
    this._updatedAt = at;
  }

  private assertSameCurrency(amount: Money): void {
    if (amount.currency !== this.currency) throw new CurrencyMismatchError();
  }
}
