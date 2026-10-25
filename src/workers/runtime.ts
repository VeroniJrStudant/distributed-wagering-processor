import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config.ts';
import type { AppLogger } from '../infrastructure/observability/logger.ts';
import { JsonLogger } from '../infrastructure/observability/logger.ts';
import { WagerConsumer } from '../infrastructure/messaging/consumer.ts';
import { OutboxPublisher } from '../infrastructure/messaging/outbox-publisher.ts';
import { PendingReferenceWorker } from '../infrastructure/messaging/pending-worker.ts';

@Injectable()
export class WorkerRuntime implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(WagerConsumer) private readonly consumer: WagerConsumer,
    @Inject(OutboxPublisher) private readonly publisher: OutboxPublisher,
    @Inject(PendingReferenceWorker) private readonly pending: PendingReferenceWorker,
    @Inject(JsonLogger) private readonly logger: AppLogger,
  ) {}

  onModuleInit(): void {
    if (this.config.role === 'api') return;
    this.consumer.start();
    this.timer = setInterval(() => {
      void this.publisher.publishBatch().catch((error: unknown) => {
        this.logger.error('outbox tick failed', { name: error instanceof Error ? error.name : 'Error' });
      });
      void this.pending.run().catch((error: unknown) => {
        this.logger.error('pending reference tick failed', { name: error instanceof Error ? error.name : 'Error' });
      });
    }, 1000);
    this.timer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.config.role !== 'api') await this.consumer.stop();
  }
}
