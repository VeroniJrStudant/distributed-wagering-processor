import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { APP_CONFIG, type AppConfig } from './config.ts';
import { AuthGuard } from './infrastructure/auth/auth.guard.ts';
import { JsonLogger } from './infrastructure/observability/logger.ts';
import { correlationMiddleware } from './interfaces/http/correlation.middleware.ts';
import { AllExceptionsFilter } from './interfaces/http/exception.filter.ts';
import { AppModule } from './app.module.ts';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  const logger = app.get(JsonLogger);
  const config = app.get<AppConfig>(APP_CONFIG);
  app.useLogger(logger);
  app.use(correlationMiddleware);
  app.useGlobalFilters(new AllExceptionsFilter(logger));
  app.useGlobalGuards(new AuthGuard());
  app.enableShutdownHooks();
  await app.listen(config.port);
  logger.info('wagering processor listening', { port: config.port, role: config.role });
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
