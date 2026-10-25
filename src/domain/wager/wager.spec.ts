import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InsufficientFundsError, InvalidTransactionStateError } from '../errors.ts';
import { Money } from '../money/money.ts';
import { LedgerDirection } from '../wallet/ledger-direction.ts';
import { Wallet } from '../wallet/wallet.ts';
import { applyMovement } from './apply-movement.ts';
import { FailureCode } from './failure-code.ts';
import { evaluateReference } from './reference-policy.ts';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from './wager-transaction.ts';

const now = new Date('2026-07-29T15:00:00.000Z');
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

function tx(kind: WagerTransactionKind, amount: string, reference?: string, id = kind.toLowerCase()): WagerTransaction {
  return WagerTransaction.create({
    id,
    providerId: 'provider-a',
    externalTransactionId: id,
    idempotencyKey: `provider-a:${id}`,
    payloadHash: `hash-${id}`,
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: brl(amount),
    referenceExternalTransactionId: reference,
    correlationId: 'corr-1',
    createdAt: now,
  });
}

function processed(kind: WagerTransactionKind, amount: string, id = kind.toLowerCase()): WagerTransaction {
  const wager = tx(kind, amount, kind === WagerTransactionKind.Refund ? 'bet' : undefined, id);
  wager.markProcessed(undefined, now);
  return wager;
}

describe('wager rules', () => {
  test('BET debits, WIN credits, and LOSS does not move the balance', () => {
    const account = Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: brl('100.00'), now });
    const bet = tx(WagerTransactionKind.Bet, '25.00');
    const betEntry = applyMovement({ wallet: account, wager: bet, entryId: 'e1', at: now });
    expect(betEntry?.direction).toBe(LedgerDirection.Debit);
    expect(account.balance.toJSON().amount).toBe('75.00');
    expect(account.version).toBe(2);

    const win = tx(WagerTransactionKind.Win, '10.00', undefined, 'win');
    applyMovement({ wallet: account, wager: win, entryId: 'e2', at: now });
    expect(account.balance.toJSON().amount).toBe('85.00');

    const version = account.version;
    const loss = tx(WagerTransactionKind.Loss, '25.00', undefined, 'loss');
    expect(applyMovement({ wallet: account, wager: loss, entryId: 'e3', at: now })).toBeUndefined();
    expect(account.balance.toJSON().amount).toBe('85.00');
    expect(account.version).toBe(version);
  });

  test('REFUND credits the bet and ROLLBACK inverts the referenced direction', () => {
    const account = Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: brl('100.00'), now });
    const bet = processed(WagerTransactionKind.Bet, '30.00', 'bet');
    applyMovement({ wallet: account, wager: tx(WagerTransactionKind.Bet, '30.00', undefined, 'bet'), entryId: 'e1', at: now });
    const refund = tx(WagerTransactionKind.Refund, '30.00', 'bet', 'refund');
    expect(refund.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    applyMovement({ wallet: account, wager: refund, reference: bet, entryId: 'e2', at: now });
    expect(account.balance.toJSON().amount).toBe('100.00');

    const win = processed(WagerTransactionKind.Win, '40.00', 'win');
    applyMovement({ wallet: account, wager: tx(WagerTransactionKind.Win, '40.00', undefined, 'win'), entryId: 'e3', at: now });
    const rollback = tx(WagerTransactionKind.Rollback, '40.00', 'win', 'rollback');
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    applyMovement({ wallet: account, wager: rollback, reference: win, entryId: 'e4', at: now });
    expect(account.balance.toJSON().amount).toBe('100.00');
  });

  test('a reversal that would go negative is a distinct insufficient-funds error', () => {
    const account = Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: brl('10.00'), now });
    const win = processed(WagerTransactionKind.Win, '40.00', 'win');
    const rollback = tx(WagerTransactionKind.Rollback, '40.00', 'win', 'rollback');
    expect(() => applyMovement({ wallet: account, wager: rollback, reference: win, entryId: 'e1', at: now })).toThrow(
      InsufficientFundsError,
    );
    try {
      applyMovement({ wallet: account, wager: rollback, reference: win, entryId: 'e1', at: now });
    } catch (error) {
      expect(error).toBeInstanceOf(InsufficientFundsError);
      expect((error as InsufficientFundsError).reversal).toBe(true);
      expect((error as InsufficientFundsError).code).toBe(FailureCode.InsufficientFundsForReversal);
    }
    expect(account.balance.toJSON().amount).toBe('10.00');
  });

  test('currency conflict is rejected by the wallet', () => {
    const account = Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: brl('10.00'), now });
    const usd = WagerTransaction.create({
      id: 'usd',
      providerId: 'provider-a',
      externalTransactionId: 'usd',
      idempotencyKey: 'provider-a:usd',
      payloadHash: 'hash',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '1.00', currency: 'USD' }),
      correlationId: 'corr-1',
      createdAt: now,
    });
    expect(() => applyMovement({ wallet: account, wager: usd, entryId: 'e1', at: now })).toThrow(CurrencyMismatchError);
  });

  test('terminal states cannot transition', () => {
    const bet = processed(WagerTransactionKind.Bet, '1.00');
    expect(bet.isTerminal()).toBe(true);
    expect(() => bet.reject(FailureCode.InsufficientFunds, now)).toThrow(InvalidTransactionStateError);
    expect(() => bet.markProcessed(undefined, now)).toThrow(InvalidTransactionStateError);
  });

  test('reference policy waits, rejects a second reversal, and allows a win of a different amount', () => {
    const bet = processed(WagerTransactionKind.Bet, '25.00', 'bet');
    const earlyRefund = tx(WagerTransactionKind.Refund, '25.00', 'missing', 'refund-early');
    expect(evaluateReference({ transaction: earlyRefund, alreadyReversed: false }).type).toBe('wait');

    const refund = tx(WagerTransactionKind.Refund, '25.00', 'bet', 'refund');
    expect(evaluateReference({ transaction: refund, reference: bet, alreadyReversed: false })).toMatchObject({
      type: 'ready',
    });
    expect(evaluateReference({ transaction: refund, reference: bet, alreadyReversed: true }).type).toBe('reject');

    const partial = tx(WagerTransactionKind.Refund, '10.00', 'bet', 'partial');
    expect(evaluateReference({ transaction: partial, reference: bet, alreadyReversed: false })).toEqual({
      type: 'reject',
      code: FailureCode.AmountMismatch,
    });

    const win = tx(WagerTransactionKind.Win, '80.00', 'bet', 'win');
    expect(evaluateReference({ transaction: win, reference: bet, alreadyReversed: false }).type).toBe('ready');

    const otherRound = WagerTransaction.create({
      id: 'other',
      providerId: 'provider-a',
      externalTransactionId: 'other',
      idempotencyKey: 'provider-a:other',
      payloadHash: 'hash',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-2',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Refund,
      money: brl('25.00'),
      referenceExternalTransactionId: 'bet',
      correlationId: 'corr-1',
      createdAt: now,
    });
    expect(evaluateReference({ transaction: otherRound, reference: bet, alreadyReversed: false })).toEqual({
      type: 'reject',
      code: FailureCode.ReferenceScopeMismatch,
    });

    const rollbackLoss = tx(WagerTransactionKind.Rollback, '25.00', 'bet', 'rollback');
    const loss = processed(WagerTransactionKind.Loss, '25.00', 'loss');
    expect(evaluateReference({ transaction: rollbackLoss, reference: loss, alreadyReversed: false })).toEqual({
      type: 'reject',
      code: FailureCode.ReferenceKindNotAllowed,
    });
  });

  test('OPENING cannot be submitted and a processed transaction reports its direction', () => {
    expect(() =>
      WagerTransaction.create({
        id: 'opening',
        providerId: 'internal',
        externalTransactionId: 'opening',
        idempotencyKey: 'opening',
        payloadHash: 'hash',
        walletId: 'wallet-1',
        playerId: 'player-1',
        roundId: 'opening',
        gameId: 'opening',
        kind: WagerTransactionKind.Opening,
        money: brl('1.00'),
        correlationId: 'corr-1',
        createdAt: now,
      }),
    ).toThrow('OPENING');
    const opening = WagerTransaction.createOpening({
      id: 'opening',
      walletId: 'wallet-1',
      playerId: 'player-1',
      money: brl('50.00'),
      payloadHash: 'hash',
      correlationId: 'corr-1',
      createdAt: now,
    });
    expect(opening.status).toBe(WagerTransactionStatus.Pending);
    expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });
});
