import { DomainError, InvalidTransactionStateError } from '../errors.ts';
import { Money } from '../money/money.ts';
import { LedgerDirection } from '../wallet/ledger-direction.ts';
import { FailureCode } from './failure-code.ts';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

const TERMINAL = new Set<WagerTransactionStatus>([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  correlationId: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  attemptCount: number;
  nextAttemptAt?: Date;
  observedBalance?: Money;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly correlationId: string,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _attemptCount = 0,
    private _nextAttemptAt?: Date,
    private _observedBalance?: Money,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new DomainError('INVALID_KIND', 'OPENING cannot be submitted externally');
    }
    return WagerTransaction.pending(props);
  }

  static createOpening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    payloadHash: string;
    correlationId: string;
    createdAt: Date;
  }): WagerTransaction {
    const external = `opening:${props.walletId}`;
    return WagerTransaction.pending({
      id: props.id,
      providerId: 'internal',
      externalTransactionId: external,
      idempotencyKey: external,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: 'opening',
      gameId: 'opening',
      kind: WagerTransactionKind.Opening,
      money: props.money,
      correlationId: props.correlationId,
      createdAt: props.createdAt,
    });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.correlationId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.attemptCount,
      state.nextAttemptAt,
      state.observedBalance,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get attemptCount(): number {
    return this._attemptCount;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertMutable('markProcessed');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._failureCode = undefined;
    this._nextAttemptAt = undefined;
  }

  markPendingReference(): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(this._status, 'markPendingReference');
    }
    this._status = WagerTransactionStatus.PendingReference;
  }

  /** First wait before any worker attempt. Does not consume an attempt. */
  armRetry(at: Date): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(this._status, 'armRetry');
    }
    this._nextAttemptAt = at;
  }

  scheduleRetry(now: Date, policy: { baseMs: number; capMs: number }): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(this._status, 'scheduleRetry');
    }
    this._attemptCount += 1;
    const exponent = Math.min(this._attemptCount - 1, 6);
    const delay = Math.min(policy.capMs, policy.baseMs * 2 ** exponent);
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }

  reject(code: FailureCode, at: Date): void {
    this.assertMutable('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertMutable('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
  }

  snapshotBalance(balance: Money): void {
    this._observedBalance = balance;
  }

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new DomainError('REFERENCE_REQUIRED', 'Rollback requires the referenced transaction');
        }
        const referenced = reference.ledgerDirectionFor();
        return referenced === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new DomainError('LEDGER_NOT_APPLICABLE', 'LOSS does not generate a ledger entry');
    }
  }

  private assertMutable(event: string): void {
    if (this.isTerminal()) throw new InvalidTransactionStateError(this._status, event);
  }

  private static pending(props: CreateWagerTransactionProps): WagerTransaction {
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.correlationId,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );
  }
}
