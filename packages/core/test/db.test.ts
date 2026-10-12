import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../../../test/helpers/db';
import { createDb, migrate, type Db } from '../src/db';

let db: Db;
let drop: () => Promise<void>;
beforeAll(async () => ({ db, drop } = await createTestDb()));
afterAll(async () => drop());

describe('migrations', () => {
  it('are applied once', async () => {
    expect(await migrate(db)).toEqual([]);
    const { rows } = await db.query('SELECT name FROM schema_migrations ORDER BY name');
    expect(rows.map((r) => r.name)).toEqual(['0001_init']);
  });

  it('create all tables', async () => {
    const { rows } = await db.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name COLLATE "C"`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'agents', 'idempotency_keys', 'links', 'nudges', 'owner', 'owner_sessions', 'projects',
      'schema_migrations', 'session_activity', 'sessions', 'task_events', 'tasks',
    ]);
  });

  it('pg_trgm works on Cyrillic', async () => {
    const { rows } = await db.query(`SELECT similarity('добавить импорт csv', 'импорт csv файлов') AS s`);
    expect(rows[0].s).toBeGreaterThan(0.3);
  });
});

describe('createDb', () => {
  it('handles idle client errors instead of crashing the process', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The pool connects lazily, so no server is needed to inspect it.
    const pool = createDb('postgres://localhost:1/none');
    try {
      expect(pool.listenerCount('error')).toBeGreaterThan(0);
      const err = new Error('terminating connection due to administrator command');
      // Without a listener, EventEmitter would throw here.
      expect(() => pool.emit('error', err)).not.toThrow();
      expect(spy).toHaveBeenCalledWith('[db] idle client error', err);
    } finally {
      spy.mockRestore();
      await pool.end();
    }
  });
});
