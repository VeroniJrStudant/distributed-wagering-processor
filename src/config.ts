export type AppRole = 'all' | 'api' | 'worker';

export interface AppConfig {
  port: number;
  role: AppRole;
  databaseUrl: string;
  sqsEndpoint: string;
  awsRegion: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  wagerQueueName: string;
  dlqQueueName: string;
  eventsQueueName: string;
  consumerName: string;
  referenceMaxAttempts: number;
  referenceBackoffBaseMs: number;
  referenceBackoffCapMs: number;
  sqsVisibilityTimeoutSeconds: number;
  sqsWaitTimeSeconds: number;
  crashAfterCommit: boolean;
  eagerReferenceResolution: boolean;
  logLevel: string;
}

export const APP_CONFIG = Symbol('APP_CONFIG');
export const ORM = Symbol('ORM');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const role = env.APP_ROLE ?? 'all';
  if (role !== 'all' && role !== 'api' && role !== 'worker') {
    throw new Error('APP_ROLE must be all, api, or worker');
  }
  return {
    port: numberFrom(env.PORT, 3000),
    role,
    databaseUrl: env.DATABASE_URL ?? 'postgres://wager:wager@localhost:5432/wagering',
    sqsEndpoint: env.SQS_ENDPOINT ?? 'http://localhost:4566',
    awsRegion: env.AWS_REGION ?? 'us-east-1',
    awsAccessKeyId: env.AWS_ACCESS_KEY_ID ?? 'test',
    awsSecretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? 'test',
    wagerQueueName: env.WAGER_QUEUE_NAME ?? 'wager-transactions.fifo',
    dlqQueueName: env.DLQ_QUEUE_NAME ?? 'wager-transactions-dlq.fifo',
    eventsQueueName: env.EVENTS_QUEUE_NAME ?? 'integration-events.fifo',
    consumerName: env.CONSUMER_NAME ?? 'wager-transactions',
    referenceMaxAttempts: numberFrom(env.REFERENCE_MAX_ATTEMPTS, 8),
    referenceBackoffBaseMs: numberFrom(env.REFERENCE_BACKOFF_BASE_MS, 1000),
    referenceBackoffCapMs: numberFrom(env.REFERENCE_BACKOFF_CAP_MS, 60_000),
    sqsVisibilityTimeoutSeconds: numberFrom(env.SQS_VISIBILITY_TIMEOUT, 30),
    sqsWaitTimeSeconds: numberFrom(env.SQS_WAIT_TIME_SECONDS, 20),
    crashAfterCommit: env.CRASH_AFTER_COMMIT === '1',
    eagerReferenceResolution: env.EAGER_REFERENCE_RESOLUTION !== 'false',
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}

function numberFrom(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid numeric env value: ${value}`);
  return parsed;
}
