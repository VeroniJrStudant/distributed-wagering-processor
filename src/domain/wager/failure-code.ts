export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  InsufficientFundsForReversal = 'INSUFFICIENT_FUNDS_FOR_REVERSAL',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  PlayerWalletMismatch = 'PLAYER_WALLET_MISMATCH',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceRequired = 'REFERENCE_REQUIRED',
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  ReferenceScopeMismatch = 'REFERENCE_SCOPE_MISMATCH',
  AmountMismatch = 'AMOUNT_MISMATCH',
  AlreadyReversed = 'ALREADY_REVERSED',
  InvalidAmount = 'INVALID_AMOUNT',
  InvalidKind = 'INVALID_KIND',
}
