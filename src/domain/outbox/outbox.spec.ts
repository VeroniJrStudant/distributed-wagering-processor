import { describe, expect, test } from 'bun:test';
import { OutboxMessage } from './outbox-message.ts';
import { IntegrationEvent, type IntegrationEventProps } from '../events/integration-event.ts';

class SampleEvent extends IntegrationEvent<{ ok: true }> {
  readonly eventType = 'SampleEvent';
  readonly version = 1;

  constructor(props: IntegrationEventProps<{ ok: true }>) {
    super(props);
  }
}

describe('OutboxMessage', () => {
  test('retries with exponential backoff and then publishes once', () => {
    const event = new SampleEvent({
      eventId: 'event-1',
      aggregateId: 'wallet-1',
      correlationId: 'corr-1',
      occurredAt: new Date('2026-07-29T15:00:00.000Z'),
      data: { ok: true },
    });
    const message = OutboxMessage.enqueue(event);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(new Date('2026-07-29T15:00:00.000Z'))).toBe(true);
    message.scheduleRetry(new Date('2026-07-29T15:00:00.000Z'));
    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt?.toISOString()).toBe('2026-07-29T15:00:02.000Z');
    expect(message.isDue(new Date('2026-07-29T15:00:01.000Z'))).toBe(false);
    message.markPublished(new Date('2026-07-29T15:00:03.000Z'));
    expect(message.isPending()).toBe(false);
    message.markPublished(new Date('2026-07-29T15:00:04.000Z'));
    expect(message.publishedAt?.toISOString()).toBe('2026-07-29T15:00:03.000Z');
  });
});
