import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { clamp } from './clamp';

export interface RepoContext { root: string; rootName: string; rootPathHash: string; remote: string | null; branch: string | null; head: string | null }
export type GitRunner = (cwd: string, args: string[], timeoutMs?: number) => string | null;

export const runGit: GitRunner = (cwd, args, timeoutMs = 1500) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs, windowsHide: true }).trim() || null;
  } catch {
    return null;
  }
};

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

/** One entry of the HEAD reflog. */
export interface ReflogEntry {
  sha: string;
  /** When HEAD moved there (ms; git records seconds). */
  time: number;
  /** `%gs`, e.g. `commit: x`, `commit (amend): x`, `checkout: moving from a to b`, `pull: Fast-forward`. */
  action: string;
  /** The commit's subject. */
  subject: string;
}

/** A reflog action that created a commit: `commit:`, `commit (amend):`, `commit (initial):`, `commit (merge):`. */
export const COMMIT_ACTION_RE = /^commit(?: \([^)]*\))?:/;
const AMEND_ACTION_RE = /^commit \(amend\):/;

/**
 * The newest `n` HEAD reflog entries, newest first, in one bounded git call
 * (`git log -g -n <n> --date=unix --format=%H%x00%gd%x00%gs%x00%s`: `%gd` is `HEAD@{<unix time>}` under --date=unix).
 * Null on any git error.
 */
export function reflog(cwd: string, run: GitRunner = runGit, timeoutMs = 1500, n = 50): ReflogEntry[] | null {
  const out = run(cwd, ['log', '-g', '-n', String(n), '--date=unix', '--format=%H%x00%gd%x00%gs%x00%s', 'HEAD'], timeoutMs);
  if (!out) return null;
  const entries: ReflogEntry[] = [];
  for (const line of out.split('\n')) {
    const [sha, selector, action, ...subject] = line.split('\0');
    const time = /@\{(\d+)\}$/.exec(selector ?? '');
    if (!sha || !FULL_SHA_RE.test(sha) || !time || action === undefined) continue;
    entries.push({ sha, time: Number(time[1]) * 1000, action, subject: clamp(subject.join('\0'), 300) });
  }
  return entries.length ? entries : null;
}

/**
 * The full sha and subject of the commit a (short) sha names in THIS repo (`<sha>^{commit}`) — Claude Code's
 * `gitOperation.commit.sha` is 7 chars and may name a commit made in another repo. Null on any git error or timeout,
 * an unknown or ambiguous sha, a non-commit object, or anything that is not a hex sha (never passed to git).
 */
export function resolveCommit(cwd: string, sha: string, run: GitRunner = runGit, timeoutMs = 1500): { sha: string; subject: string } | null {
  if (!/^[0-9a-f]{4,40}$/i.test(sha)) return null;
  const out = run(cwd, ['log', '-1', '--format=%H%x1f%s', `${sha}^{commit}`, '--'], timeoutMs);
  if (!out) return null;
  const [full, ...subject] = out.split('\x1f');
  return full && FULL_SHA_RE.test(full) && full.toLowerCase().startsWith(sha.toLowerCase())
    ? { sha: full, subject: clamp(subject.join('\x1f'), 300) }
    : null;
}

/** HEAD@{1} when the newest reflog entry is the `commit (amend)` that created `sha`; null otherwise. */
export function amendedFrom(entries: ReflogEntry[] | null, sha: string): string | null {
  const top = entries?.[0];
  if (!top || top.sha.toLowerCase() !== sha.toLowerCase() || !AMEND_ACTION_RE.test(top.action)) return null;
  const previous = entries![1]?.sha;
  return previous && previous.toLowerCase() !== sha.toLowerCase() ? previous : null;
}

export function rootPathHash(root: string, platform: NodeJS.Platform = process.platform): string {
  let p = root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (platform === 'win32') p = p.toLowerCase();
  return createHash('sha256').update(p).digest('hex');
}

/**
 * Removes credentials from a remote URL before it leaves the machine: in scheme URLs everything
 * between `scheme://` and the last `@` of the authority (`user:password@`, `token@`) is dropped.
 * scp-style remotes (`git@host:path`) have no scheme and are returned unchanged; `git@` is not a secret.
 */
export function sanitizeRemote(remote: string | null): string | null {
  if (!remote) return remote;
  return remote.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, '$1');
}

export function repoContext(cwd: string, run: GitRunner = runGit): RepoContext | null {
  const root = run(cwd, ['rev-parse', '--show-toplevel']);
  if (!root) return null;
  const branch = run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return {
    root,
    rootName: basename(root.replace(/\\/g, '/')),
    rootPathHash: rootPathHash(root),
    remote: sanitizeRemote(run(cwd, ['remote', 'get-url', 'origin'])),
    branch: branch === 'HEAD' ? null : branch,
    head: run(cwd, ['rev-parse', 'HEAD']),
  };
}

export function headCommit(cwd: string, run: GitRunner = runGit): { sha: string; subject: string } | null {
  const out = run(cwd, ['log', '-1', '--format=%H%x09%s']);
  if (!out) return null;
  const [sha, ...rest] = out.split('\t');
  return sha ? { sha, subject: clamp(rest.join('\t'), 300) } : null;
}
