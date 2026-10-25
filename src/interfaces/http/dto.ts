import { z } from 'zod';

export const moneySchema = z.object({
  amount: z.string().regex(/^(0|[1-9]\d*)\.\d{2}$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
}).strict();

export const wagerFieldsSchema = z.object({
  providerId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/),
  externalTransactionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_:.-]{0,127}$/),
  playerId: z.string().uuid(),
  walletId: z.string().uuid(),
  roundId: z.string().trim().min(1).max(128),
  gameId: z.string().trim().min(1).max(128),
  kind: z.enum(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']),
  money: moneySchema,
  referenceExternalTransactionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_:.-]{0,127}$/).optional(),
}).superRefine((value, context) => {
  if ((value.kind === 'REFUND' || value.kind === 'ROLLBACK') && !value.referenceExternalTransactionId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['referenceExternalTransactionId'],
      message: 'referenceExternalTransactionId is required',
    });
  }
});

export const openWalletSchema = z.object({
  playerId: z.string().uuid(),
  initialBalance: moneySchema,
}).strict();

export const queueMessageSchema = z.object({
  messageId: z.string().trim().min(1).max(128),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.string().min(1),
  data: wagerFieldsSchema.and(z.object({
    idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_:.\-]{0,199}$/),
  })),
});

export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_:.\-]{0,199}$/);
export const uuidSchema = z.string().uuid();
