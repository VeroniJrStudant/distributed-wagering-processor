import { ApplicationError } from './application-error.ts';

export function assertSameSubmission(
  existing: { idempotencyKey: string; payloadHash: string },
  request: { idempotencyKey: string; payloadHash: string },
): void {
  if (existing.idempotencyKey !== request.idempotencyKey) {
    throw new ApplicationError(
      'IDEMPOTENCY_KEY_MISMATCH',
      'This external transaction is already bound to another Idempotency-Key',
      409,
    );
  }
  if (existing.payloadHash !== request.payloadHash) {
    throw new ApplicationError(
      'IDEMPOTENCY_PAYLOAD_CONFLICT',
      'Idempotency-Key was reused with a different payload',
      409,
    );
  }
}
