import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config.ts';
import type { EventContext } from '../domain/events/wager-events.ts';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/events/wager-events.ts';
import { CurrencyMismatchError, DomainError, InsufficientFundsError } from '../domain/errors.ts';
import type { Clock, IdGenerator } from '../domain/ids.ts';
import { SystemClock, UuidGenerator } from '../domain/ids.ts';
import { InboxMessage } from '../domain/inbox/inbox-message.ts';
import type { MoneyProps } from '../domain/money/money.ts';
import { Money } from '../domain/money/money.ts';
import { OutboxMessage } from '../domain/outbox/outbox-message.ts';
import type { WalletLedgerEntry } from '../domain/wallet/ledger-entry.ts';
import type { Wallet } from '../domain/wallet/wallet.ts';
import { applyMovement } from '../domain/wager/apply-movement.ts';
import { FailureCode } from '../domain/wager/failure-code.ts';
import { evaluateReference } from '../domain/wager/reference-policy.ts';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../domain/wager/wager-transaction.ts';
import { ApplicationError } from './application-error.ts';
import { assertSameSubmission } from './idempotency.ts';
import { hashBusinessPayload } from './payload-hash.ts';
import type { AppLogger, MetricsPort, ProviderIdentityPort, ReadModel, TxRepos, UnitOfWork } from './ports.ts';
import { findCode, isDeadlock, isUniqueViolation } from './sql-state.ts';
import { APP_LOGGER, APP_METRICS, PROVIDER_IDENTITY, READ_MODEL, UNIT_OF_WORK } from './tokens.ts';

export interface SubmitWagerInput {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface SubmitContext {
  correlationId: string;
  inbox?: {
    consumerName: string;
    messageId: string;
    payloadHash: string;
  };
}

export interface SubmitResult {
  httpStatus: number;
  duplicate?: 'inbox' | 'idempotency';
  body: {
    transactionId: string;
    status: WagerTransactionStatus;
    balance: MoneyProps;
    idempotentReplay: boolean;
    failureCode?: FailureCode;
  };
}

/**
 * The wallet row lock is the concurrency boundary. Inbox, balance, ledger and
 * outbox are written in that same database transaction and flushed in an order
 * the foreign keys accept: wager, then ledger.
 */
@Injectable()
export class WagerProcessor {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(READ_MODEL) private readonly reads: ReadModel,
    @Inject(SystemClock) private readonly clock: Clock,
    @Inject(UuidGenerator) private readonly ids: IdGenerator,
    @Inject(APP_METRICS) private readonly metrics: MetricsPort,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort,
  ) {}

  async submit(input: SubmitWagerInput, ctx: SubmitContext): Promise<SubmitResult> {
    this.identity.assertCanSubmit(input.providerId);
    const normalized = normalizeInput(input);
    const payloadHash = hashBusinessPayload(normalized);
    const started = performance.now();
    try {
      const result = await this.withRetry(() => this.uow.run((repos) => this.attempt(repos, normalized, ctx, payloadHash)));
      if (result.duplicate) this.metrics.increment('duplicates_detected_total', { source: result.duplicate });
      else this.metrics.increment('wager_transactions_total', { status: result.body.status, kind: normalized.kind });
      this.logger.info('wager submission completed', {
        transactionId: result.body.transactionId,
        walletId: normalized.walletId,
        providerId: normalized.providerId,
        status: result.body.status,
        failureCode: result.body.failureCode,
        correlationId: ctx.correlationId,
        messageId: ctx.inbox?.messageId,
        idempotentReplay: result.body.idempotentReplay,
      });
      return result;
    } catch (error) {
      if (error instanceof ApplicationError && (error.httpStatus === 409)) {
        this.metrics.increment('idempotency_conflicts_total');
      }
      throw error;
    } finally {
      this.metrics.observe('processing_duration_seconds', (performance.now() - started) / 1000, { operation: 'submit' });
    }
  }

  async resume(transactionId: string, options?: { force?: boolean }): Promise<void> {
    const located = await this.reads.transaction(transactionId);
    if (!located || located.status !== WagerTransactionStatus.PendingReference) return;
    const now = this.clock.now();
    if (!options?.force && located.nextAttemptAt && located.nextAttemptAt > now) return;
    await this.withRetry(() =>
      this.uow.run(async (repos) => {
        const wallet = await repos.wallets.lockById(located.walletId);
        if (!wallet) return;
        const fresh = await repos.wagers.findById(transactionId);
        if (!fresh || fresh.status !== WagerTransactionStatus.PendingReference) return;
        await this.continuePending(repos, wallet, fresh, this.clock.now(), true);
      }),
    );
  }

  private async withRetry<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await work();
      } catch (error) {
        if (attempt < 3 && (isDeadlock(error) || isUniqueViolation(error))) {
          this.metrics.increment('lock_conflicts_total', { code: findCode(error) ?? 'unknown' });
          continue;
        }
        throw error;
      }
    }
    throw new ApplicationError('TRANSIENT_FAILURE', 'Could not complete the transaction', 503);
  }

  private async attempt(
    repos: TxRepos,
    input: SubmitWagerInput,
    ctx: SubmitContext,
    payloadHash: string,
  ): Promise<SubmitResult> {
    const now = this.clock.now();
    const wallet = await repos.wallets.lockById(input.walletId);
    if (!wallet) throw new ApplicationError('WALLET_NOT_FOUND', 'Wallet was not found', 404);

    const duplicate = await this.acknowledgeInbox(repos, ctx, now);
    const existing = await this.findExisting(repos, input);
    if (duplicate === 'processed-inbox') {
      if (!existing) throw new ApplicationError('INBOX_WITHOUT_TRANSACTION', 'Processed inbox has no transaction', 500);
      assertSameSubmission(existing, { idempotencyKey: input.idempotencyKey, payloadHash });
      return { ...this.toResult(existing, true), duplicate: 'inbox' };
    }
    if (existing) {
      assertSameSubmission(existing, { idempotencyKey: input.idempotencyKey, payloadHash });
      return { ...this.toResult(existing, true), duplicate: 'idempotency' };
    }

    const money = Money.from(input.money);
    const wager = WagerTransaction.create({
      id: this.ids.uuid(),
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money,
      referenceExternalTransactionId: input.referenceExternalTransactionId,
      correlationId: ctx.correlationId,
      createdAt: now,
    });

    if (wallet.playerId !== input.playerId) {
      return this.rejectNew(repos, wallet, wager, FailureCode.PlayerWalletMismatch, now);
    }
    if (wallet.currency !== money.currency) {
      return this.rejectNew(repos, wallet, wager, FailureCode.CurrencyMismatch, now);
    }
    if (wager.affectsBalance() && !money.isPositive()) {
      return this.rejectNew(repos, wallet, wager, FailureCode.InvalidAmount, now);
    }

    const decision = await this.decide(repos, wager);
    if (decision.type === 'reject') return this.rejectNew(repos, wallet, wager, decision.code, now);
    if (decision.type === 'wait') return this.park(repos, wallet, wager, now);
    return this.applyNew(repos, wallet, wager, decision.reference, now);
  }

  private async acknowledgeInbox(
    repos: TxRepos,
    ctx: SubmitContext,
    now: Date,
  ): Promise<'processed-inbox' | 'recorded' | 'absent'> {
    if (!ctx.inbox) return 'absent';
    const existing = await repos.inbox.find(ctx.inbox.consumerName, ctx.inbox.messageId);
    if (existing?.isProcessed()) {
      if (existing.payloadHash !== ctx.inbox.payloadHash) {
        throw new ApplicationError('INBOX_PAYLOAD_CONFLICT', 'Inbox message id was reused with a different payload', 409);
      }
      return 'processed-inbox';
    }
    if (existing && existing.payloadHash !== ctx.inbox.payloadHash) {
      throw new ApplicationError('INBOX_PAYLOAD_CONFLICT', 'Inbox message id was reused with a different payload', 409);
    }
    const message = existing ?? InboxMessage.receive({
      messageId: ctx.inbox.messageId,
      consumerName: ctx.inbox.consumerName,
      payloadHash: ctx.inbox.payloadHash,
      receivedAt: now,
    });
    message.markProcessed(now);
    repos.inbox.save(message);
    return 'recorded';
  }

  private async findExisting(repos: TxRepos, input: SubmitWagerInput): Promise<WagerTransaction | null> {
    const byKey = await repos.wagers.findByIdempotencyKey(input.idempotencyKey);
    const byExternal = await repos.wagers.findByExternal(input.providerId, input.externalTransactionId);
    if (byKey && byExternal && byKey.id !== byExternal.id) {
      throw new ApplicationError(
        'IDEMPOTENCY_CONFLICT',
        'Idempotency key and external id point at different transactions',
        409,
      );
    }
    return byKey ?? byExternal;
  }

  private async decide(repos: TxRepos, wager: WagerTransaction) {
    const cited = wager.referenceExternalTransactionId;
    const needsLookup = wager.requiresReference() || (wager.kind === WagerTransactionKind.Win && cited !== undefined);
    if (!needsLookup) return evaluateReference({ transaction: wager, alreadyReversed: false });
    const reference = cited ? await repos.wagers.findByExternal(wager.providerId, cited) : null;
    const alreadyReversed =
      wager.requiresReference() && cited
        ? await repos.wagers.hasProcessedReversal(wager.providerId, cited)
        : false;
    return evaluateReference({
      transaction: wager,
      reference: reference ?? undefined,
      alreadyReversed,
    });
  }

  private async park(repos: TxRepos, wallet: Wallet, wager: WagerTransaction, now: Date): Promise<SubmitResult> {
    wager.markPendingReference();
    wager.armRetry(new Date(now.getTime() + this.config.referenceBackoffBaseMs));
    wager.snapshotBalance(wallet.balance);
    repos.wagers.save(wager);
    repos.outbox.add(OutboxMessage.enqueue(
      WagerTransactionPendingReference.from(wager, this.event(wager.correlationId, wager.id, now)),
    ));
    await repos.flush();
    return this.toResult(wager, false);
  }

  private async applyNew(
    repos: TxRepos,
    wallet: Wallet,
    wager: WagerTransaction,
    reference: WagerTransaction | undefined,
    now: Date,
  ): Promise<SubmitResult> {
    const moved = this.move(wallet, wager, reference, now);
    if (moved.failure) return this.rejectNew(repos, wallet, wager, moved.failure, now);
    wager.markProcessed(reference?.id, now);
    wager.snapshotBalance(wallet.balance);
    if (moved.entry) repos.wallets.save(wallet);
    repos.wagers.save(wager);
    this.enqueueProcessed(repos, wallet, wager, moved.entry, now);
    await repos.flush();
    if (moved.entry) {
      repos.ledger.add(moved.entry);
      await repos.flush();
    }
    if (this.config.eagerReferenceResolution) await this.resolveWaiters(repos, wallet, wager, now);
    return this.toResult(wager, false);
  }

  private async continuePending(
    repos: TxRepos,
    wallet: Wallet,
    wager: WagerTransaction,
    now: Date,
    countWait: boolean,
  ): Promise<void> {
    if (wager.walletId !== wallet.id) return;
    if (wager.affectsBalance() && !wager.money.isPositive()) {
      await this.rejectExisting(repos, wallet, wager, FailureCode.InvalidAmount, now);
      return;
    }
    const decision = await this.decide(repos, wager);
    if (decision.type === 'wait') {
      if (!countWait) return;
      if (wager.attemptCount >= this.config.referenceMaxAttempts) {
        await this.rejectExisting(repos, wallet, wager, FailureCode.ReferenceNotFound, now);
        return;
      }
      wager.scheduleRetry(now, {
        baseMs: this.config.referenceBackoffBaseMs,
        capMs: this.config.referenceBackoffCapMs,
      });
      repos.wagers.save(wager);
      await repos.flush();
      this.metrics.increment('retries_total', { source: 'pending_reference' });
      return;
    }
    if (decision.type === 'reject') {
      await this.rejectExisting(repos, wallet, wager, decision.code, now);
      return;
    }
    await this.applyExisting(repos, wallet, wager, decision.reference, now);
  }

  private async applyExisting(
    repos: TxRepos,
    wallet: Wallet,
    wager: WagerTransaction,
    reference: WagerTransaction | undefined,
    now: Date,
  ): Promise<void> {
    const moved = this.move(wallet, wager, reference, now);
    if (moved.failure) {
      await this.rejectExisting(repos, wallet, wager, moved.failure, now);
      return;
    }
    wager.markProcessed(reference?.id, now);
    wager.snapshotBalance(wallet.balance);
    if (moved.entry) repos.wallets.save(wallet);
    repos.wagers.save(wager);
    this.enqueueProcessed(repos, wallet, wager, moved.entry, now);
    await repos.flush();
    if (moved.entry) {
      repos.ledger.add(moved.entry);
      await repos.flush();
    }
    this.metrics.increment('wager_transactions_total', { status: wager.status, kind: wager.kind });
  }

  private async resolveWaiters(repos: TxRepos, wallet: Wallet, processed: WagerTransaction, now: Date): Promise<void> {
    if (processed.status !== WagerTransactionStatus.Processed) return;
    const waiters = await repos.wagers.findPendingReferencing(processed.providerId, processed.externalTransactionId);
    for (const waiter of waiters) {
      if (waiter.walletId !== wallet.id || waiter.status !== WagerTransactionStatus.PendingReference) continue;
      await this.continuePending(repos, wallet, waiter, now, false);
    }
  }

  private move(
    wallet: Wallet,
    wager: WagerTransaction,
    reference: WagerTransaction | undefined,
    now: Date,
  ): { entry?: WalletLedgerEntry; failure?: FailureCode } {
    try {
      return { entry: applyMovement({ wallet, wager, reference, entryId: this.ids.uuid(), at: now }) };
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        return {
          failure: error.reversal ? FailureCode.InsufficientFundsForReversal : FailureCode.InsufficientFunds,
        };
      }
      if (error instanceof CurrencyMismatchError) return { failure: FailureCode.CurrencyMismatch };
      if (error instanceof DomainError && error.code === FailureCode.InvalidAmount) {
        return { failure: FailureCode.InvalidAmount };
      }
      throw error;
    }
  }

  private async rejectNew(
    repos: TxRepos,
    wallet: Wallet,
    wager: WagerTransaction,
    code: FailureCode,
    now: Date,
  ): Promise<SubmitResult> {
    this.reject(repos, wallet, wager, code, now);
    await repos.flush();
    return this.toResult(wager, false);
  }

  private async rejectExisting(
    repos: TxRepos,
    wallet: Wallet,
    wager: WagerTransaction,
    code: FailureCode,
    now: Date,
  ): Promise<void> {
    this.reject(repos, wallet, wager, code, now);
    await repos.flush();
    this.metrics.increment('wager_transactions_total', { status: wager.status, kind: wager.kind });
  }

  private reject(repos: TxRepos, wallet: Wallet, wager: WagerTransaction, code: FailureCode, now: Date): void {
    wager.snapshotBalance(wallet.balance);
    wager.reject(code, now);
    repos.wagers.save(wager);
    repos.outbox.add(OutboxMessage.enqueue(
      WagerTransactionRejected.from(wager, this.event(wager.correlationId, wager.id, now)),
    ));
  }

  private enqueueProcessed(
    repos: TxRepos,
    wallet: Wallet,
    wager: WagerTransaction,
    entry: WalletLedgerEntry | undefined,
    now: Date,
  ): void {
    repos.outbox.add(OutboxMessage.enqueue(
      WagerTransactionProcessed.from(wallet, wager, this.event(wager.correlationId, wager.id, now)),
    ));
    if (!entry) return;
    repos.outbox.add(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, this.event(wager.correlationId, wager.id, now))));
  }

  private event(correlationId: string, causationId: string, occurredAt: Date): EventContext {
    return { eventId: this.ids.uuid(), correlationId, causationId, occurredAt };
  }

  private toResult(wager: WagerTransaction, idempotentReplay: boolean): SubmitResult {
    if (!wager.observedBalance) {
      throw new ApplicationError('MISSING_OBSERVED_BALANCE', 'Transaction has no observed balance', 500);
    }
    return {
      httpStatus: httpStatusFor(wager.status),
      body: {
        transactionId: wager.id,
        status: wager.status,
        balance: wager.observedBalance.toJSON(),
        idempotentReplay,
        ...(wager.failureCode ? { failureCode: wager.failureCode } : {}),
      },
    };
  }
}

function normalizeInput(input: SubmitWagerInput): SubmitWagerInput {
  const reference = input.referenceExternalTransactionId?.trim();
  return { ...input, referenceExternalTransactionId: reference ? reference : undefined };
}

function httpStatusFor(status: WagerTransactionStatus): number {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return 200;
    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.PendingReference:
      return 202;
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.Failed:
      return 500;
  }
}
