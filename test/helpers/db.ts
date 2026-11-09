import { inject } from 'vitest';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { createDb, migrate, type Db } from '../../packages/core/src/db';

export async function createTestDb(): Promise<{ db: Db; url: string; drop: () => Promise<void> }> {
  const adminUrl = inject('pgAdminUrl');
  const name = 't_' + randomBytes(6).toString('hex');
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  // en_US.utf8 ctype (pg_trgm on Cyrillic) is spelled en_US.UTF-8 on macOS.
  for (const locale of ['en_US.utf8', 'en_US.UTF-8']) {
    try {
      await admin.query(`CREATE DATABASE ${name} ENCODING 'UTF8' TEMPLATE template0 LC_CTYPE '${locale}' LC_COLLATE '${locale}'`);
      break;
    } catch (e) {
      if (locale === 'en_US.UTF-8') throw e;
    }
  }
  await admin.end();
  const u = new URL(adminUrl);
  u.pathname = '/' + name;
  const url = u.toString();
  const db = createDb(url);
  await migrate(db);
  return {
    db,
    url,
    drop: async () => {
      await db.end();
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}
