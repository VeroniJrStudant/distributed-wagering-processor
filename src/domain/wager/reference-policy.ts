import { FailureCode } from './failure-code.ts';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from './wager-transaction.ts';

export type ReferenceDecision =
  | { type: 'ready'; reference?: WagerTransaction }
  | { type: 'wait' }
  | { type: 'reject'; code: FailureCode };

/**
 * Reference rules live here so they can be tested without a database.
 * WIN may cite the bet of the same round. REFUND and ROLLBACK must cite one.
 * Amount equality applies only to REFUND and ROLLBACK; a win can pay a different amount.
 * gameId is intentionally not part of the scope: the spec lists provider, player, wallet, currency, and round.
 * alreadyReversed means any processed REFUND or ROLLBACK already points at this reference.
 * A second reversal of the other kind would credit the same movement twice.
 */
export function evaluateReference(input: {
  transaction: WagerTransaction;
  reference?: WagerTransaction;
  alreadyReversed: boolean;
}): ReferenceDecision {
  const transaction = input.transaction;
  const cited = transaction.referenceExternalTransactionId;
  const optionalWinReference = transaction.kind === WagerTransactionKind.Win && cited !== undefined;
  if (!transaction.requiresReference() && !optionalWinReference) {
    return { type: 'ready' };
  }
  if (!cited) return { type: 'reject', code: FailureCode.ReferenceRequired };
  if (!input.reference || input.reference.status !== WagerTransactionStatus.Processed) {
    return { type: 'wait' };
  }
  const reference = input.reference;
  if (
    reference.providerId !== transaction.providerId ||
    reference.playerId !== transaction.playerId ||
    reference.walletId !== transaction.walletId ||
    reference.money.currency !== transaction.money.currency ||
    reference.roundId !== transaction.roundId
  ) {
    return { type: 'reject', code: FailureCode.ReferenceScopeMismatch };
  }
  if (!kindAllowed(transaction.kind, reference.kind)) {
    return { type: 'reject', code: FailureCode.ReferenceKindNotAllowed };
  }
  if (
    (transaction.kind === WagerTransactionKind.Refund || transaction.kind === WagerTransactionKind.Rollback) &&
    !transaction.money.equals(reference.money)
  ) {
    return { type: 'reject', code: FailureCode.AmountMismatch };
  }
  if (
    input.alreadyReversed &&
    (transaction.kind === WagerTransactionKind.Refund || transaction.kind === WagerTransactionKind.Rollback)
  ) {
    return { type: 'reject', code: FailureCode.AlreadyReversed };
  }
  return { type: 'ready', reference };
}

function kindAllowed(kind: WagerTransactionKind, referenced: WagerTransactionKind): boolean {
  if (kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Win) {
    return referenced === WagerTransactionKind.Bet;
  }
  if (kind === WagerTransactionKind.Rollback) {
    return (
      referenced === WagerTransactionKind.Bet ||
      referenced === WagerTransactionKind.Win ||
      referenced === WagerTransactionKind.Refund
    );
  }
  return false;
}
