import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { ApplicationError } from '../../application/application-error.ts';
import { OpenWallet } from '../../application/open-wallet.ts';
import { ReconcileWallet } from '../../application/reconcile-wallet.ts';
import { WagerProcessor } from '../../application/wager-processor.ts';
import { WalletQueries } from '../../application/wallet-queries.ts';
import { requestContext } from '../../infrastructure/observability/context.ts';
import { uuidv7 } from '../../domain/ids.ts';
import { WagerTransactionKind } from '../../domain/wager/wager-transaction.ts';
import { idempotencyKeySchema, openWalletSchema, uuidSchema, wagerFieldsSchema } from './dto.ts';

@Controller()
export class WalletsController {
  constructor(
    @Inject(OpenWallet) private readonly openWallet: OpenWallet,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
    @Inject(ReconcileWallet) private readonly reconcile: ReconcileWallet,
  ) {}

  @Post('wallets')
  @HttpCode(201)
  open(@Body() body: unknown) {
    return this.openWallet.execute(openWalletSchema.parse(body), correlationId());
  }

  @Get('wallets/:walletId')
  get(@Param('walletId') walletId: string) {
    return this.queries.getWallet(parseUuid(walletId));
  }

  @Get('wallets/:walletId/ledger')
  ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.queries.getLedger(parseUuid(walletId), cursor, parseLimit(limit));
  }

  @Post('wallets/:walletId/reconciliation')
  @HttpCode(200)
  reconciliation(@Param('walletId') walletId: string) {
    return this.reconcile.execute(parseUuid(walletId));
  }
}

@Controller()
export class WageringController {
  constructor(
    @Inject(WagerProcessor) private readonly processor: WagerProcessor,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | string[] | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const key = parseIdempotencyKey(idempotencyKey);
    const payload = wagerFieldsSchema.parse(body);
    const result = await this.processor.submit({
      idempotencyKey: key,
      providerId: payload.providerId,
      externalTransactionId: payload.externalTransactionId,
      playerId: payload.playerId,
      walletId: payload.walletId,
      roundId: payload.roundId,
      gameId: payload.gameId,
      kind: payload.kind as WagerTransactionKind,
      money: payload.money,
      referenceExternalTransactionId: payload.referenceExternalTransactionId,
    }, { correlationId: correlationId() });
    response.status(result.httpStatus);
    return result.body;
  }

  @Get('wagering/transactions/:transactionId')
  byId(@Param('transactionId') transactionId: string) {
    return this.queries.getTransaction(parseUuid(transactionId));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  byExternal(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    const provider = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/).parse(providerId);
    const external = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_:.-]{0,127}$/).parse(externalTransactionId);
    return this.queries.getByExternal(provider, external);
  }
}

function correlationId(): string {
  return requestContext.getStore()?.correlationId ?? uuidv7();
}

function parseUuid(value: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) throw new ApplicationError('INVALID_IDENTIFIER', 'identifier must be a uuid', 400);
  return parsed.data;
}

function parseLimit(value: string | undefined): number {
  if (value === undefined || value === '') return 50;
  if (!/^\d+$/.test(value)) throw new ApplicationError('INVALID_LIMIT', 'limit must be an integer', 400);
  const limit = Number(value);
  if (limit < 1 || limit > 100) throw new ApplicationError('INVALID_LIMIT', 'limit must be between 1 and 100', 400);
  return limit;
}

function parseIdempotencyKey(value: string | string[] | undefined): string {
  const key = Array.isArray(value) ? value[0] : value;
  if (!key) throw new ApplicationError('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required', 400);
  const parsed = idempotencyKeySchema.safeParse(key);
  if (!parsed.success) throw new ApplicationError('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key has an invalid format', 400);
  return parsed.data;
}
