import { afterAll, expect, test } from 'bun:test';
import { Client } from 'pg';
import { createDatabase, dropDatabase } from '../support/database.ts';

const name = `wager_mig_${process.pid}`;

afterAll(async () => {
  await dropDatabase(name);
});

test('migrations apply, reverse, and apply again', async () => {
  const url = await createDatabase(name);
  const { migrate } = await import('../../src/infrastructure/persistence/migrate.ts');
  await migrate(url, 'up');
  expect(await tableExists(url, 'wallets')).toBe(true);
  expect(await tableExists(url, 'wallet_ledger_entries')).toBe(true);
  await migrate(url, 'down');
  expect(await tableExists(url, 'wallets')).toBe(false);
  await migrate(url, 'up');
  expect(await tableExists(url, 'wager_transactions')).toBe(true);
});

async function tableExists(url: string, table: string): Promise<boolean> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query('SELECT to_regclass($1) AS name', [`public.${table}`]);
    return result.rows[0].name !== null;
  } finally {
    await client.end();
  }
}
