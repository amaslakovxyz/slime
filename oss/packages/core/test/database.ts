// The demo Postgres from sandbox/db/init.sql (docker compose in sandbox/, or CI's
// service). Tests read these URLs from env; core itself never does.
import pg from 'pg';

export const READER_URL = process.env.DATABASE_URL ?? 'postgres://slime_reader:slime_reader@localhost:54329/slime';
export const WRITER_URL = process.env.WRITER_DATABASE_URL ?? 'postgres://slime_writer:slime_writer@localhost:54329/slime';

const CONNECT_TIMEOUT_MS = 2_000;

/** Locally, database tests are skipped when Postgres is down; CI sets REQUIRE_DB=1 so they fail instead. */
export async function isDatabaseAvailable(): Promise<boolean> {
  const client = new pg.Client({ connectionString: READER_URL, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch (error) {
    const reason = (error as Error).message;
    if (process.env.REQUIRE_DB === '1') throw new Error(`REQUIRE_DB=1 but Postgres is unreachable: ${reason}`);
    console.warn(`# skipping database tests: ${reason} (start it with: cd sandbox && npm run db:up)`);
    return false;
  }
}

/** Runs SQL as slime_writer, which owns the slime_meta schema. */
export async function asWriter(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: WRITER_URL });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}
