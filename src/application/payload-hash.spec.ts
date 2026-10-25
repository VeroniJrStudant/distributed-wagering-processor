import { describe, expect, test } from 'bun:test';
import { canonicalJson, hashBusinessPayload } from './payload-hash.ts';
import { ApplicationError } from './application-error.ts';
import { assertSameSubmission } from './idempotency.ts';

describe('payload hash', () => {
  const payload = {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  };

  test('key order does not change the hash and the idempotency key is not part of it', () => {
    const reordered = canonicalJson({
      z: 1,
      a: { d: true, b: 'x' },
    });
    expect(reordered).toBe('{"a":{"b":"x","d":true},"z":1}');
    expect(hashBusinessPayload(payload)).toBe(hashBusinessPayload({ ...payload }));
    expect(hashBusinessPayload({ ...payload, money: { amount: '26.00', currency: 'BRL' } })).not.toBe(
      hashBusinessPayload(payload),
    );
  });

  test('the same key with a different payload is a conflict, not a replay', () => {
    expect(() =>
      assertSameSubmission(
        { idempotencyKey: 'provider-a:transaction-123', payloadHash: 'aaa' },
        { idempotencyKey: 'provider-a:transaction-123', payloadHash: 'bbb' },
      ),
    ).toThrow(ApplicationError);
    try {
      assertSameSubmission(
        { idempotencyKey: 'provider-a:transaction-123', payloadHash: 'aaa' },
        { idempotencyKey: 'provider-a:transaction-123', payloadHash: 'bbb' },
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationError);
      expect((error as ApplicationError).code).toBe('IDEMPOTENCY_PAYLOAD_CONFLICT');
      expect((error as ApplicationError).httpStatus).toBe(409);
    }
  });

  test('the same external transaction bound to another key is a conflict', () => {
    expect(() =>
      assertSameSubmission(
        { idempotencyKey: 'key-a', payloadHash: 'aaa' },
        { idempotencyKey: 'key-b', payloadHash: 'aaa' },
      ),
    ).toThrow(ApplicationError);
  });
});
