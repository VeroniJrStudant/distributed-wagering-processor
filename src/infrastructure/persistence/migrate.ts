import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { loadConfig } from '../../config.ts';

export async function migrate(databaseUrl: string, direction: 'up' | 'down'): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../migrations');
    const appliedRows = await client.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version');
    const applied = appliedRows.rows.map((row) => row.version);
    if (direction === 'up') {
      const files = (await readdir(dir)).filter((file) => file.endsWith('.up.sql')).sort();
      for (const file of files) {
        const version = file.slice(0, -'.up.sql'.length);
        if (applied.includes(version)) continue;
        await apply(client, path.join(dir, file), 'INSERT INTO schema_migrations (version) VALUES ($1)', version);
      }
      return;
    }
    const latest = applied.at(-1);
    if (!latest) return;
    await apply(
      client,
      path.join(dir, `${latest}.down.sql`),
      'DELETE FROM schema_migrations WHERE version = $1',
      latest,
    );
  } finally {
    await client.end();
  }
}

async function apply(client: Client, file: string, bookmarkSql: string, version: string): Promise<void> {
  const sql = await readFile(file, 'utf8');
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query(bookmarkSql, [version]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

if (process.argv[1]?.endsWith('migrate.ts')) {
  const direction = process.argv[2];
  if (direction !== 'up' && direction !== 'down') {
    process.stderr.write('usage: bun src/infrastructure/persistence/migrate.ts up|down\n');
    process.exit(1);
  }
  migrate(loadConfig().databaseUrl, direction).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
