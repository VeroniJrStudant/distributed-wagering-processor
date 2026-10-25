export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super('INVALID_MONEY', message);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor() {
    super('CURRENCY_MISMATCH', 'Operations require the same currency');
  }
}

export class InsufficientFundsError extends DomainError {
  constructor(readonly reversal: boolean) {
    super(
      reversal ? 'INSUFFICIENT_FUNDS_FOR_REVERSAL' : 'INSUFFICIENT_FUNDS',
      reversal ? 'Reversal would make the balance negative' : 'Insufficient funds',
    );
  }
}

export class InvalidTransactionStateError extends DomainError {
  constructor(from: string, event: string) {
    super('INVALID_TRANSACTION_STATE', `Cannot ${event} from status ${from}`);
  }
}
