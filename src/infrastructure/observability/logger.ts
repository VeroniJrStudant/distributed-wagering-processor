import type { AppLogger } from '../../application/ports.ts';
import { requestContext } from './context.ts';

export type { AppLogger };

const REDACTED = new Set([
  'amount',
  'balance',
  'money',
  'payload',
  'authorization',
  'body',
  'initialBalance',
  'data',
  'password',
  'secret',
  'observedBalance',
]);

export class JsonLogger implements AppLogger {
  info(message: string, fields?: Record<string, unknown>): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.write('error', message, fields);
  }

  log(message: unknown, context?: unknown): void {
    this.write('info', String(message), contextFields(context));
  }

  verbose(message: unknown, context?: unknown): void {
    this.write('debug', String(message), contextFields(context));
  }

  debug(message: unknown, context?: unknown): void {
    this.write('debug', String(message), contextFields(context));
  }

  private write(level: string, message: string, fields?: Record<string, unknown>): void {
    const store = requestContext.getStore();
    const entry = {
      level,
      time: new Date().toISOString(),
      message,
      ...(store ?? {}),
      ...sanitize(fields),
    };
    const stream = level === 'error' ? process.stderr : process.stdout;
    stream.write(`${JSON.stringify(entry)}\n`);
  }
}

function contextFields(context: unknown): Record<string, unknown> | undefined {
  if (typeof context === 'string') return { context };
  if (context && typeof context === 'object') return context as Record<string, unknown>;
  return undefined;
}

function sanitize(fields?: Record<string, unknown>): Record<string, unknown> {
  if (!fields || typeof fields !== 'object') return {};
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (REDACTED.has(key) || value === undefined) continue;
    clean[key] = value instanceof Error ? value.name : value;
  }
  return clean;
}
