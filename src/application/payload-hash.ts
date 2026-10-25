import { createHash } from 'node:crypto';

export interface BusinessPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

/** Canonical JSON: sorted keys, no insignificant whitespace. SHA-256 hex of that text. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function hashBusinessPayload(payload: BusinessPayload): string {
  const canonical = canonicalJson({
    externalTransactionId: payload.externalTransactionId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: {
      amount: payload.money.amount,
      currency: payload.money.currency,
    },
    playerId: payload.playerId,
    providerId: payload.providerId,
    referenceExternalTransactionId: payload.referenceExternalTransactionId ?? null,
    roundId: payload.roundId,
    walletId: payload.walletId,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
