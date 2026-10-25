import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { InboxSchema, LedgerSchema, OutboxSchema, WagerSchema, WalletSchema } from './entities.ts';

export function mikroOptions(databaseUrl: string) {
  return {
    driver: PostgreSqlDriver,
    clientUrl: databaseUrl,
    entities: [WalletSchema, WagerSchema, LedgerSchema, InboxSchema, OutboxSchema],
    connect: false,
    allowGlobalContext: true,
    forceUtcTimezone: true,
    pool: { min: 0, max: 20 },
    debug: false,
  };
}
