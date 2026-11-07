import pg from 'pg';
import { config } from '../config.js';

// numeric -> number, int8 -> number (sizes/counters fit in 2^53).
pg.types.setTypeParser(1700, (v: string) => Number.parseFloat(v));
pg.types.setTypeParser(20, (v: string) => Number.parseInt(v, 10));

let pool: pg.Pool | undefined;

export function db(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: config().databaseUrl, max: 10, idleTimeoutMillis: 30_000 });
    pool.on('error', (err) => {
      // Idle client errors must not crash the process.
      console.error('[db] idle client error', err.message);
    });
  }
  return pool;
}

export type Queryable = pg.Pool | pg.PoolClient;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  client: Queryable = db(),
): Promise<T[]> {
  const r = await client.query<T>(text, params);
  return r.rows;
}

export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  client: Queryable = db(),
): Promise<T | null> {
  const r = await client.query<T>(text, params);
  return r.rows[0] ?? null;
}

/** Run `fn` inside a transaction, committing on success and rolling back on error. */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function closeDb(): Promise<void> {
  if (pool) await pool.end();
  pool = undefined;
}
