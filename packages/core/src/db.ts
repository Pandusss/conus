import pg from 'pg';
import { MIGRATIONS } from './migrations';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

// bigint (int8) → number: ids from bigserial and count(*) stay well below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));

export function createDb(url: string, max = 10): Db {
  const pool = new pg.Pool({ connectionString: url, max });
  // node-postgres re-emits idle-client errors (Postgres restart, pg_terminate_backend,
  // network reset) on the pool; without a listener Node crashes the process.
  pool.on('error', (err) => console.error('[db] idle client error', err));
  return pool;
}

export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}

const MIGRATION_LOCK = 727_001;

export async function migrate(db: Db): Promise<string[]> {
  const client = await db.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    for (const m of MIGRATIONS) {
      const { rowCount } = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [m.name]);
      if (rowCount) continue;
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [m.name]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
      applied.push(m.name);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
  return applied;
}
