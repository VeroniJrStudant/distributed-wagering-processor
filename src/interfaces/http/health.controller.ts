import { Controller, Get, HttpException, HttpStatus, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { MikroORM } from '@mikro-orm/core';
import { ORM } from '../../config.ts';
import { Metrics } from '../../infrastructure/observability/metrics.ts';
import { SqsGateway } from '../../infrastructure/messaging/sqs-gateway.ts';

@Controller()
export class HealthController {
  constructor(
    @Inject(ORM) private readonly orm: MikroORM,
    @Inject(SqsGateway) private readonly sqs: SqsGateway,
  ) {}

  @Get('health/live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('health/ready')
  async ready(): Promise<{ status: string; checks: { postgres: string; sqs: string } }> {
    const checks = { postgres: 'ok', sqs: 'ok' };
    try {
      if (!this.orm.isConnected()) await this.orm.connect();
      await this.orm.em.getConnection().execute('SELECT 1');
    } catch {
      checks.postgres = 'down';
    }
    try {
      await this.sqs.ping();
    } catch {
      checks.sqs = 'down';
    }
    if (checks.postgres !== 'ok' || checks.sqs !== 'ok') {
      throw new HttpException({ status: 'degraded', checks }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return { status: 'ok', checks };
  }
}

@Controller()
export class MetricsController {
  constructor(@Inject(Metrics) private readonly metrics: Metrics) {}

  @Get('metrics')
  metricsEndpoint(@Res() response: Response): void {
    response.type('text/plain; version=0.0.4').send(this.metrics.render());
  }
}
