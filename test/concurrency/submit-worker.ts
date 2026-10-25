import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module.ts';
import { WagerProcessor } from '../../src/application/wager-processor.ts';

const input = JSON.parse(process.argv[2] ?? '');
const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
try {
  const result = await app.get(WagerProcessor).submit(input, { correlationId: String(input.idempotencyKey) });
  process.stdout.write(`${JSON.stringify(result.body)}\n`);
} finally {
  await app.close();
}
