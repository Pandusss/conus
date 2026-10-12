import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ApiError, type Api } from './api-client';
import { writeFileAtomic } from './fsutil';

const MAX_AGE_MS = 7 * 86_400_000;
/** An event whose session the server still does not know after this long lost its session/start for good. */
const UNKNOWN_SESSION_MAX_AGE_MS = 60 * 60 * 1000;
const LOCK_FILE = '.flush.lock';
/** A lock older than this was left by a hook process that died mid-flush. */
const LOCK_STALE_MS = 30_000;

// 4xx statuses that say "not this event's fault" (bad/expired credentials, wrong URL, throttling):
// the event must survive until the config or server is fixed. Every other 4xx is a permanent
// rejection of this payload (400, 409, 413, 422, ...) and the event is dropped — except a 409
// `unknown_session`, which only says the session's queued session/start has not arrived yet.
const RETRYABLE_4XX = new Set([401, 403, 404, 408, 429]);

/** The server does not know the event's session (yet): retry once its session/start got through. */
export const isUnknownSession = (e: unknown): boolean =>
  e instanceof ApiError && e.status === 409 && (e.body as { error?: { code?: unknown } } | null)?.error?.code === 'unknown_session';

export const isPermanentRejection = (e: unknown): boolean =>
  e instanceof ApiError && e.status >= 400 && e.status < 500 && !RETRYABLE_4XX.has(e.status) && !isUnknownSession(e);

// force: a concurrent flush (another hook process) may already have removed the file.
const remove = (file: string) => rmSync(file, { force: true });

let enqueued = 0;

export function enqueue(dir: string, path: string, body: unknown, now = Date.now()): void {
  mkdirSync(dir, { recursive: true });
  // Files are sent in name order. Events of one process often share a millisecond (a session/start and the facts
  // after it): the counter keeps their order, which the random part alone would leave to chance.
  const name = `${String(now).padStart(15, '0')}-${String(enqueued++).padStart(6, '0')}-${randomBytes(4).toString('hex')}.json`;
  writeFileAtomic(join(dir, name), JSON.stringify({ path, body, createdAt: now }));
}

/**
 * One flushing process at a time (hooks run concurrently, e.g. an async PostToolUse next to Stop): without it two
 * processes could send the same events, and a late duplicate session/start could revive a session that has ended.
 * Returns the release function, or null when another live process holds the lock.
 */
function lock(dir: string): (() => void) | null {
  const file = join(dir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, String(process.pid), { flag: 'wx' });
      return () => remove(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      try {
        if (Date.now() - statSync(file).mtimeMs < LOCK_STALE_MS) return null;
        remove(file);
      } catch {
        return null;
      }
    }
  }
  return null;
}

const sessionOf = (body: unknown): string | null => {
  const id = (body as { agent_session_id?: unknown } | null)?.agent_session_id;
  return typeof id === 'string' ? id : null;
};

/**
 * Sends queued events oldest first within `budgetMs`. Stops at the first transient failure (server down, 5xx, 429,
 * bad token): later events wait behind it, keeping their order. A permanent rejection drops that event. An
 * `unknown_session` reply keeps the event and every later event of the same session (their session/start has not
 * reached the server yet; other sessions go on), and drops it once it is older than an hour.
 */
export async function flushOutbox(dir: string, api: Api, budgetMs = 1000, now = Date.now()) {
  const list = () => readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  let files: string[] = [];
  try { files = list(); } catch { return { sent: 0, dropped: 0, left: 0 }; }
  if (!files.length) return { sent: 0, dropped: 0, left: 0 };
  const release = lock(dir);
  if (!release) return { sent: 0, dropped: 0, left: files.length };
  const started = Date.now();
  let sent = 0, dropped = 0;
  const waiting = new Set<string>();
  try {
    try { files = list(); } catch { return { sent, dropped, left: 0 }; }
    for (let i = 0; i < files.length; i++) {
      const file = join(dir, files[i]!);
      let item: { path: string; body: unknown; createdAt: number };
      try { item = JSON.parse(readFileSync(file, 'utf8')); } catch { remove(file); dropped++; continue; }
      if (now - item.createdAt > MAX_AGE_MS) { remove(file); dropped++; continue; }
      const sid = sessionOf(item.body);
      if (sid !== null && waiting.has(sid)) continue;
      const remaining = budgetMs - (Date.now() - started);
      if (remaining <= 50) break;
      try {
        await api.post(item.path, item.body, Math.min(remaining, 1000));
        remove(file);
        sent++;
      } catch (e) {
        if (isPermanentRejection(e)) {
          remove(file);
          dropped++;
          continue;
        }
        if (isUnknownSession(e)) {
          if (now - item.createdAt > UNKNOWN_SESSION_MAX_AGE_MS) {
            remove(file);
            dropped++;
          } else if (sid !== null) {
            waiting.add(sid);
          }
          continue;
        }
        break;
      }
    }
    return { sent, dropped, left: files.length - sent - dropped };
  } finally {
    release();
  }
}
