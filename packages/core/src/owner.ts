import { hash, verify } from '@node-rs/argon2';
import { createHash, randomBytes } from 'node:crypto';
import { withTx, type Db, type Queryable } from './db';
import { DomainError } from './errors';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export async function setOwnerPassword(db: Db, password: string): Promise<void> {
  if (!password || password.length < 8) throw new DomainError('validation', 'Password must be at least 8 characters.');
  const h = await hash(password); // argon2id defaults
  await withTx(db, async (tx) => {
    await tx.query(
      `INSERT INTO owner(id, password_hash) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
      [h],
    );
    // A password change must log out every existing owner session.
    await tx.query('DELETE FROM owner_sessions');
  });
}

/**
 * First-run setup in the browser: sets the owner password only while there is none, atomically, so two racing
 * requests cannot both win. False when an owner already exists.
 */
export async function claimOwner(db: Db, password: string): Promise<boolean> {
  if (!password || password.length < 8) throw new DomainError('validation', 'Password must be at least 8 characters.');
  const h = await hash(password);
  const r = await db.query('INSERT INTO owner(id, password_hash) VALUES (1, $1) ON CONFLICT (id) DO NOTHING', [h]);
  return !!r.rowCount;
}

export async function hasOwner(q: Queryable): Promise<boolean> {
  const { rowCount } = await q.query('SELECT 1 FROM owner WHERE id = 1');
  return !!rowCount;
}

export async function verifyOwnerPassword(db: Db, password: string): Promise<boolean> {
  const { rows } = await db.query('SELECT password_hash FROM owner WHERE id = 1');
  if (!rows[0]) return false;
  try {
    return await verify(rows[0].password_hash, password);
  } catch {
    return false;
  }
}

export async function createOwnerSession(q: Queryable, ttlDays = 30): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await q.query(
    `INSERT INTO owner_sessions(token_hash, expires_at) VALUES ($1, now() + make_interval(days => $2))`,
    [sha(token), ttlDays],
  );
  return token;
}

export async function validateOwnerSession(q: Queryable, token: string): Promise<boolean> {
  if (!token) return false;
  const { rowCount } = await q.query('SELECT 1 FROM owner_sessions WHERE token_hash = $1 AND expires_at > now()', [sha(token)]);
  return !!rowCount;
}

export async function deleteOwnerSession(q: Queryable, token: string): Promise<void> {
  await q.query('DELETE FROM owner_sessions WHERE token_hash = $1', [sha(token)]);
}
