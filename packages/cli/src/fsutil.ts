import { chmodSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

/** Injection points for tests; production code passes nothing. */
export interface AtomicWriteIo {
  rename?: (from: string, to: string) => void;
  platform?: NodeJS.Platform;
  sleep?: (ms: number) => void;
}

// On Windows, renaming over a file that another process (an antivirus scanner, the indexer, a
// concurrent hook reading state) holds open fails with EPERM/EBUSY/EACCES for a few milliseconds.
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80]; // 5 attempts in total

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetry(from: string, to: string, io: AtomicWriteIo): void {
  const rename = io.rename ?? renameSync;
  const platform = io.platform ?? process.platform;
  const sleep = io.sleep ?? sleepSync;
  for (let attempt = 0; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | null)?.code;
      const retry = platform === 'win32' && code !== undefined && RETRYABLE_RENAME_CODES.has(code) && attempt < RENAME_RETRY_DELAYS_MS.length;
      if (!retry) throw e;
      sleep(RENAME_RETRY_DELAYS_MS[attempt]!);
    }
  }
}

/**
 * Writes `data` to a temp file next to `path` and renames it over the target, so readers never see a
 * partial file and an existing file's permissions are replaced rather than inherited. `mode` is applied
 * when the temp file is created and, on POSIX, enforced again with chmod after the rename (umask can
 * only narrow the creation mode). The temp file never ends in `.json`, so directory scans ignore it.
 * On win32 a rename rejected with EPERM/EBUSY/EACCES is retried a few times (~150 ms in total).
 */
export function writeFileAtomic(path: string, data: string, mode?: number, io: AtomicWriteIo = {}): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, data, mode === undefined ? undefined : { mode });
    renameWithRetry(tmp, path, io);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
  if (mode !== undefined && process.platform !== 'win32') chmodSync(path, mode);
}

/**
 * Where an atomic replace of `path` must land: the real file behind a symlink, so a dotfiles-managed
 * `~/.codex/config.toml` or `AGENTS.md` stays a symlink instead of being swapped for a regular file.
 * A path that does not exist (yet) is returned unchanged.
 */
export function resolveWriteTarget(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}
