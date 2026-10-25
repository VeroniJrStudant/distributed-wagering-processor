import 'reflect-metadata';
import { EntityManager, MikroORM } from '@mikro-orm/core';
import { Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { APP_CONFIG, ORM, loadConfig, type AppConfig } from './config.ts';
import { SystemClock, UuidGenerator } from './domain/ids.ts';
import { UnauthenticatedProviderIdentity } from './infrastructure/auth/provider-identity.ts';
import { AuthGuard } from './infrastructure/auth/auth.guard.ts';
import { WagerConsumer } from './infrastructure/messaging/consumer.ts';
import { OutboxPublisher } from './infrastructure/messaging/outbox-publisher.ts';
import { PendingReferenceWorker } from './infrastructure/messaging/pending-worker.ts';
import { SqsGateway } from './infrastructure/messaging/sqs-gateway.ts';
import { JsonLogger } from './infrastructure/observability/logger.ts';
import { Metrics } from './infrastructure/observability/metrics.ts';
import { mikroOptions } from './infrastructure/persistence/orm-config.ts';
import { MikroReadModel } from './infrastructure/persistence/read-model.ts';
import { SqlUnitOfWork } from './infrastructure/persistence/unit-of-work.ts';
import { HealthController, MetricsController } from './interfaces/http/health.controller.ts';
import { WageringController, WalletsController } from './interfaces/http/wallets.controller.ts';
import { OpenWallet } from './application/open-wallet.ts';
import { ReconcileWallet } from './application/reconcile-wallet.ts';
import { APP_LOGGER, APP_METRICS, PROVIDER_IDENTITY, READ_MODEL, UNIT_OF_WORK } from './application/tokens.ts';
import { WagerProcessor } from './application/wager-processor.ts';
import { WalletQueries } from './application/wallet-queries.ts';
import { WorkerRuntime } from './workers/runtime.ts';

@Injectable()
class OrmCloser implements OnModuleDestroy {
  constructor(@Inject(ORM) private readonly orm: MikroORM) {}

  async onModuleDestroy(): Promise<void> {
    await this.orm.close(true);
  }
}

@Module({
  controllers: [WalletsController, WageringController, HealthController, MetricsController],
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    {
      provide: ORM,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => MikroORM.init(mikroOptions(config.databaseUrl)),
    },
    {
      provide: EntityManager,
      inject: [ORM],
      useFactory: (orm: MikroORM) => orm.em,
    },
    { provide: SystemClock, useFactory: () => new SystemClock() },
    { provide: UuidGenerator, useFactory: () => new UuidGenerator() },
    { provide: Metrics, useFactory: () => new Metrics() },
    { provide: JsonLogger, useFactory: () => new JsonLogger() },
    { provide: UnauthenticatedProviderIdentity, useFactory: () => new UnauthenticatedProviderIdentity() },
    SqlUnitOfWork,
    MikroReadModel,
    { provide: APP_METRICS, useExisting: Metrics },
    { provide: APP_LOGGER, useExisting: JsonLogger },
    { provide: PROVIDER_IDENTITY, useExisting: UnauthenticatedProviderIdentity },
    { provide: UNIT_OF_WORK, useExisting: SqlUnitOfWork },
    { provide: READ_MODEL, useExisting: MikroReadModel },
    OrmCloser,
    OpenWallet,
    WagerProcessor,
    ReconcileWallet,
    WalletQueries,
    SqsGateway,
    WagerConsumer,
    OutboxPublisher,
    PendingReferenceWorker,
    WorkerRuntime,
    AuthGuard,
  ],
})
export class AppModule {}
