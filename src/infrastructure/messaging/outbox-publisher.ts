import { hostname } from 'node:os';
import { EntityManager, type MikroORM } from '@mikro-orm/core';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, ORM, type AppConfig } from '../../config.ts';
import { OutboxMessage } from '../../domain/outbox/outbox-message.ts';
import type { AppLogger } from '../observability/logger.ts';
import { JsonLogger } from '../observability/logger.ts';
import { Metrics } from '../observability/metrics.ts';
import { SqsGateway } from './sqs-gateway.ts';

interface ClaimedOutbox {
  id: string;
  aggregate_id: string;
  payload: Record<string, unknown> | string;
}

@Injectable()
export class OutboxPublisher {
  readonly workerId = `${hostname()}-${process.pid}`;

  constructor(
    @Inject(ORM) private readonly orm: MikroORM,
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SqsGateway) private readonly sqs: SqsGateway,
    @Inject(Metrics) private readonly metrics: Metrics,
    @Inject(JsonLogger) private readonly logger: AppLogger,
  ) {}

  async publishBatch(): Promise<number> {
    if (!this.orm.isConnected()) await this.orm.connect();
    const claimed = await this.claim(20);
    let published = 0;
    for (const row of claimed) {
      const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) as Record<string, unknown> : row.payload;
      try {
        await this.sqs.publish(this.config.eventsQueueName, payload, row.aggregate_id, row.id);
        const marked = await this.markPublished(row.id);
        if (marked) published += 1;
        this.metrics.increment('outbox_publish_total', { result: 'published' });
      } catch (error) {
        this.metrics.increment('retries_total', { source: 'outbox' });
        this.metrics.increment('outbox_publish_total', { result: 'failed' });
        await this.scheduleRetry(row.id);
        this.logger.warn('outbox publish failed', {
          outboxId: row.id,
          name: error instanceof Error ? error.name : 'Error',
        });
      }
    }
    await this.refreshLag();
    return published;
  }

  private async claim(limit: number): Promise<ClaimedOutbox[]> {
    const em = this.em.fork();
    return em.transactional(async (tx) => {
      const rows = await tx.getConnection().execute<ClaimedOutbox[]>(
        `WITH claimed AS (
           SELECT id FROM outbox_messages
           WHERE published_at IS NULL
             AND (next_attempt_at IS NULL OR next_attempt_at <= now())
             AND (locked_until IS NULL OR locked_until < now())
           ORDER BY occurred_at
           FOR UPDATE SKIP LOCKED
           LIMIT ?
         )
         UPDATE outbox_messages AS outbox
         SET locked_by = ?, locked_until = now() + interval '30 seconds'
         FROM claimed
         WHERE outbox.id = claimed.id
         RETURNING outbox.id, outbox.aggregate_id, outbox.payload`,
        [limit, this.workerId],
      );
      return rows;
    });
  }

  private async markPublished(id: string): Promise<boolean> {
    const em = this.em.fork();
    const rows = await em.getConnection().execute<Array<{ id: string }>>(
      `UPDATE outbox_messages
       SET published_at = now(), locked_by = NULL, locked_until = NULL
       WHERE id = ? AND locked_by = ? AND published_at IS NULL
       RETURNING id`,
      [id, this.workerId],
    );
    return rows.length > 0;
  }

  private async scheduleRetry(id: string): Promise<void> {
    const em = this.em.fork();
    const rows = await em.getConnection().execute<Array<{ attempts: number }>>(
      'SELECT attempts FROM outbox_messages WHERE id = ? AND published_at IS NULL',
      [id],
    );
    const current = rows[0];
    if (!current) return;
    const message = OutboxMessage.rehydrate({
      id,
      aggregateId: 'outbox',
      eventType: 'retry',
      payload: {},
      occurredAt: new Date(),
      attempts: current.attempts,
    });
    message.scheduleRetry(new Date());
    await em.getConnection().execute(
      `UPDATE outbox_messages
       SET attempts = ?, next_attempt_at = ?, locked_by = NULL, locked_until = NULL
       WHERE id = ? AND published_at IS NULL`,
      [message.attempts, message.nextAttemptAt ?? null, id],
    );
  }

  private async refreshLag(): Promise<void> {
    const em = this.em.fork();
    const rows = await em.getConnection().execute<Array<{ lag: string | number | null }>>(
      `SELECT EXTRACT(EPOCH FROM (clock_timestamp() - MIN(occurred_at))) AS lag
       FROM outbox_messages
       WHERE published_at IS NULL`,
    );
    const lag = rows[0]?.lag;
    this.metrics.setGauge('outbox_lag_seconds', lag == null ? 0 : Number(lag));
  }
}
