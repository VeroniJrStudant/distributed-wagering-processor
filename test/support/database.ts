import { Client } from 'pg';

export function databaseUrl(name: string): string {
  return `postgres://wager:wager@127.0.0.1:5432/${name}`;
}

export async function createDatabase(name: string): Promise<string> {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`invalid database name ${name}`);
  const admin = new Client({ connectionString: 'postgres://wager:wager@127.0.0.1:5432/postgres' });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  return databaseUrl(name);
}

export async function dropDatabase(name: string): Promise<void> {
  if (!/^[a-z0-9_]+$/.test(name)) return;
  const admin = new Client({ connectionString: 'postgres://wager:wager@127.0.0.1:5432/postgres' });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}
