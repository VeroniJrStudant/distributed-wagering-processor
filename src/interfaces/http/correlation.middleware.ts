import type { NextFunction, Request, Response } from 'express';
import { uuidv7 } from '../../domain/ids.ts';
import { requestContext } from '../../infrastructure/observability/context.ts';

const CORRELATION = /^[A-Za-z0-9_.:-]{1,80}$/;

export function correlationMiddleware(request: Request, response: Response, next: NextFunction): void {
  const header = request.header('x-correlation-id');
  const correlationId = header && CORRELATION.test(header) ? header : uuidv7();
  response.setHeader('x-correlation-id', correlationId);
  requestContext.run({ correlationId }, () => next());
}
