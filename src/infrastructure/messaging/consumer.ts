import { ZodError } from 'zod';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config.ts';
import { ApplicationError } from '../../application/application-error.ts';
import { hashText } from '../../application/payload-hash.ts';
import { WagerProcessor, type SubmitWagerInput } from '../../application/wager-processor.ts';
import { InvalidMoneyError } from '../../domain/errors.ts';
import { WagerTransactionKind } from '../../domain/wager/wager-transaction.ts';
import { isTransientInfrastructure } from '../persistence/pg-errors.ts';
import type { AppLogger } from '../observability/logger.ts';
import { JsonLogger } from '../observability/logger.ts';
import { Metrics } from '../observability/metrics.ts';
import { queueMessageSchema } from '../../interfaces/http/dto.ts';
import { SqsGateway, type ReceivedMessage } from './sqs-gateway.ts';

@Injectable()
export class WagerConsumer {
  private stopping = false;
  private abort = new AbortController();
  private running?: Promise<void>;
  private readonly inflight = new Set<Promise<void>>();
  private readonly busy = new Set<string>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SqsGateway) private readonly sqs: SqsGateway,
    @Inject(WagerProcessor) private readonly processor: WagerProcessor,
    @Inject(Metrics) private readonly metrics: Metrics,
    @Inject(JsonLogger) private readonly logger: AppLogger,
  ) {}

  start(): void {
    if (this.running) return;
    this.stopping = false;
    this.abort = new AbortController();
    this.running = this.loop();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.stopping = true;
    this.abort.abort();
    const grace = Math.max(1000, (this.config.sqsVisibilityTimeoutSeconds - 1) * 1000);
    await Promise.race([this.running, sleep(grace)]);
    await Promise.allSettled([...this.inflight]);
    await Promise.allSettled([...this.busy].map((handle) => this.sqs.changeVisibility(this.config.wagerQueueName, handle, 0)));
    this.running = undefined;
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      let messages: ReceivedMessage[] = [];
      try {
        messages = await this.sqs.receive(this.config.wagerQueueName, {
          waitTimeSeconds: this.config.sqsWaitTimeSeconds,
          visibilityTimeout: this.config.sqsVisibilityTimeoutSeconds,
          signal: this.abort.signal,
        });
      } catch (error) {
        if (this.stopping || isAbort(error)) return;
        this.metrics.increment('retries_total', { source: 'sqs_receive' });
        this.logger.warn('sqs receive failed', { name: error instanceof Error ? error.name : 'Error' });
        await sleep(500);
        continue;
      }
      for (const message of messages) {
        if (this.stopping) {
          await this.sqs.changeVisibility(this.config.wagerQueueName, message.receiptHandle, 0);
          continue;
        }
        const job = this.handle(message);
        this.inflight.add(job);
        await job.finally(() => this.inflight.delete(job));
      }
    }
  }

  private async handle(message: ReceivedMessage): Promise<void> {
    this.busy.add(message.receiptHandle);
    try {
      const parsed = queueMessageSchema.parse(JSON.parse(message.body));
      const input: SubmitWagerInput = {
        idempotencyKey: parsed.data.idempotencyKey,
        providerId: parsed.data.providerId,
        externalTransactionId: parsed.data.externalTransactionId,
        playerId: parsed.data.playerId,
        walletId: parsed.data.walletId,
        roundId: parsed.data.roundId,
        gameId: parsed.data.gameId,
        kind: parsed.data.kind as WagerTransactionKind,
        money: parsed.data.money,
        referenceExternalTransactionId: parsed.data.referenceExternalTransactionId,
      };
      await this.processor.submit(input, {
        correlationId: parsed.messageId,
        inbox: {
          consumerName: this.config.consumerName,
          messageId: parsed.messageId,
          payloadHash: hashText(message.body),
        },
      });
      if (this.config.crashAfterCommit) process.exit(1);
      await this.sqs.delete(this.config.wagerQueueName, message.receiptHandle);
    } catch (error) {
      await this.fail(message, error);
    } finally {
      this.busy.delete(message.receiptHandle);
    }
  }

  private async fail(message: ReceivedMessage, error: unknown): Promise<void> {
    const disposition = classify(error);
    this.logger.warn('wager message failed', {
      messageId: message.messageId,
      disposition,
      code: error instanceof ApplicationError ? error.code : error instanceof Error ? error.name : 'Error',
    });
    if (disposition === 'transient' && message.receiveCount < 5) {
      this.metrics.increment('retries_total', { source: 'sqs' });
      const delay = Math.min(60, 2 ** Math.max(1, message.receiveCount));
      await this.sqs.changeVisibility(this.config.wagerQueueName, message.receiptHandle, delay);
      return;
    }
    if (disposition !== 'conflict') {
      await this.sqs.publish(
        this.config.dlqQueueName,
        { messageId: message.messageId, body: message.body, failedAt: new Date().toISOString() },
        message.messageId.slice(0, 128) || 'dlq',
        `dlq-${message.messageId}`.slice(0, 128),
      );
      this.metrics.increment('dlq_messages_total');
    }
    await this.sqs.delete(this.config.wagerQueueName, message.receiptHandle);
  }
}

function classify(error: unknown): 'transient' | 'permanent' | 'conflict' {
  if (error instanceof ZodError || error instanceof InvalidMoneyError || error instanceof SyntaxError) return 'permanent';
  if (error instanceof ApplicationError) {
    if (error.httpStatus === 409) return 'conflict';
    if (error.httpStatus === 400) return 'permanent';
    return 'transient';
  }
  if (isTransientInfrastructure(error)) return 'transient';
  return 'transient';
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && /abort/i.test(error.name);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
