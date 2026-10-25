import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { ApplicationError } from '../../application/application-error.ts';
import { InvalidMoneyError } from '../../domain/errors.ts';
import { isTransientInfrastructure } from '../../infrastructure/persistence/pg-errors.ts';
import { requestContext } from '../../infrastructure/observability/context.ts';
import type { AppLogger } from '../../infrastructure/observability/logger.ts';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const correlationId = requestContext.getStore()?.correlationId;
    if (exception instanceof ApplicationError) {
      response.status(exception.httpStatus).json({ error: exception.code, message: exception.message, correlationId });
      return;
    }
    if (exception instanceof InvalidMoneyError) {
      response.status(400).json({ error: exception.code, message: exception.message, correlationId });
      return;
    }
    if (exception instanceof ZodError) {
      response.status(400).json({
        error: 'INVALID_PAYLOAD',
        message: 'Request payload is invalid',
        correlationId,
        issues: exception.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code })),
      });
      return;
    }
    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }
    const transient = isTransientInfrastructure(exception);
    this.logger.error(transient ? 'transient infrastructure error' : 'unhandled error', {
      name: exception instanceof Error ? exception.name : 'Error',
      correlationId,
    });
    response.status(transient ? 503 : 500).json({
      error: transient ? 'TRANSIENT_FAILURE' : 'INTERNAL_ERROR',
      message: transient ? 'Temporary infrastructure failure' : 'Internal error',
      correlationId,
    });
  }
}
