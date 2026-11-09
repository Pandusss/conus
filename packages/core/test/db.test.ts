import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../../../test/helpers/db';
import pg from 'pg';
import { createDb, migrate, type Db } from '../src/db';
import { MIGRATIONS } from '../src/migrations';

let db: Db;
let drop: () => Promise<void>;
beforeAll(async () => ({ db, drop } = await createTestDb()));
afterAll(async () => drop());

describe('migrations', () => {
  it('are applied once', async () => {
    expect(await migrate(db)).toEqual([]);
    const { rows } = await db.query('SELECT name FROM schema_migrations ORDER BY name');
    expect(rows.map((r) => r.name)).toEqual(MIGRATIONS.map((m) => m.name));
  });

  it('0002_planning upgrades a database that already has tasks: normal priority, no due date', async () => {
    const { db: fresh, drop: dropFresh } = await createTestDb();
    try {
      // roll the schema back to 0001 with a task in it, then migrate forward as a live server would
      await fresh.query(`DROP INDEX tasks_due_idx; ALTER TABLE tasks DROP COLUMN priority, DROP COLUMN priority_source, DROP COLUMN due_on;
                         DELETE FROM schema_migrations WHERE name = '0002_planning'`);
      const { rows: [p] } = await fresh.query(`INSERT INTO projects(key, name) VALUES ('OLD', 'old') RETURNING id`);
      await fresh.query(`INSERT INTO tasks(project_id, number, type, title, status) VALUES ($1, 1, 'task', 'Old task', 'todo')`, [p.id]);
      expect(await migrate(fresh)).toEqual(['0002_planning']);
      const { rows: [t] } = await fresh.query('SELECT priority, priority_source, due_on FROM tasks');
      expect(t).toEqual({ priority: 'normal', priority_source: 'default', due_on: null });
    } finally {
      await dropFresh();
    }
  });

  it('dates come back as the stored calendar day', async () => {
    const { rows } = await db.query(`SELECT '2027-01-01'::date AS d`);
    expect(rows[0].d).toBe('2027-01-01');
    expect(pg.types.getTypeParser(1082)('2027-01-01')).toBe('2027-01-01');
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
