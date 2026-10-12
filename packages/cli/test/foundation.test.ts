import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, existsSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig, writeConfig, updateConfig, configDir } from '../src/config';
import { createApi, ApiError } from '../src/api-client';
import { enqueue, flushOutbox, isPermanentRejection, isUnknownSession } from '../src/outbox';
import { amendedFrom, reflog, repoContext, resolveCommit, rootPathHash, headCommit, sanitizeRemote, type ReflogEntry } from '../src/git';
import { loadState, saveState, removeState } from '../src/state';
import { writeFileAtomic } from '../src/fsutil';

const tmp = () => mkdtempSync(join(tmpdir(), 'conus-test-'));

describe('config', () => {
  it('round-trips and lets env override', () => {
    const env = { CONUS_CONFIG_DIR: tmp() };
    expect(readConfig(env)).toBeNull();
    writeConfig({ url: 'https://conus.example.com', token: 'tm_x', sendText: true }, env);
    expect(readConfig(env)).toEqual({ url: 'https://conus.example.com', token: 'tm_x', sendText: true });
    expect(updateConfig({ sendText: false }, env).sendText).toBe(false);
    expect(readConfig({ ...env, CONUS_URL: 'http://localhost:1', CONUS_TOKEN: 'tm_env' })).toEqual({ url: 'http://localhost:1', token: 'tm_env', sendText: false });
    expect(configDir(env)).toBe(env.CONUS_CONFIG_DIR);
  });
});

describe('api client', () => {
  it('posts JSON with bearer auth, handles 204 and errors, honours timeout', async () => {
    const calls: any[] = [];
    const fake = (async (url: string, init: any) => {
      calls.push({ url, init });
      if (url.endsWith('/204')) return new Response(null, { status: 204 });
      if (url.endsWith('/401')) return new Response('{"error":{"code":"unauthorized"}}', { status: 401 });
      if (url.endsWith('/hang')) return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
      return new Response('{"ok":1}', { status: 200 });
    }) as typeof fetch;
    const api = createApi({ url: 'http://h/', token: 'tm_t' }, fake);
    expect(await api.post('/x', { a: 1 }, 1000)).toEqual({ ok: 1 });
    expect(calls[0].url).toBe('http://h/x');
    expect(calls[0].init.headers.Authorization).toBe('Bearer tm_t');
    expect(await api.post('/204', {}, 1000)).toBeNull();
    await expect(api.post('/401', {}, 1000)).rejects.toBeInstanceOf(ApiError);
    const t0 = Date.now();
    await expect(api.post('/hang', {}, 200)).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

describe('outbox', () => {
  it('flushes oldest first, drops 4xx and expired, keeps on network error', async () => {
    const dir = tmp();
    const now = Date.now();
    enqueue(dir, '/old', {}, now - 8 * 86_400_000);
    enqueue(dir, '/a', { n: 1 }, now - 2000);
    enqueue(dir, '/bad', {}, now - 1000);
    enqueue(dir, '/b', { n: 2 }, now);
    const sent: string[] = [];
    const api = {
      post: async (p: string) => { if (p === '/bad') throw new ApiError(400, {}); sent.push(p); return null; },
      get: async () => ({}),
    } as any;
    expect(await flushOutbox(dir, api, 1000, now)).toEqual({ sent: 2, dropped: 2, left: 0 });
    expect(sent).toEqual(['/a', '/b']);
    enqueue(dir, '/c', {}, now);
    const down = { post: async () => { throw new Error('ECONNREFUSED'); }, get: async () => ({}) } as any;
    expect(await flushOutbox(dir, down, 1000, now)).toEqual({ sent: 0, dropped: 0, left: 1 });
    expect(readdirSync(dir)).toHaveLength(1);
  });
  it('keeps the order of events queued within the same millisecond', async () => {
    const dir = tmp();
    const now = Date.now();
    const paths = Array.from({ length: 50 }, (_, i) => `/e${i}`);
    for (const p of paths) enqueue(dir, p, {}, now);
    const sent: string[] = [];
    const api = { post: async (p: string) => { sent.push(p); return null; }, get: async () => ({}) } as any;
    await flushOutbox(dir, api, 5000, now);
    expect(sent).toEqual(paths);
  });
});

describe('git', () => {
  const fakeGit = (map: Record<string, string | null>) => (_cwd: string, args: string[]) => map[args.join(' ')] ?? null;
  it('builds repo context with remote/branch/head', () => {
    const ctx = repoContext('C:\\w\\repo\\src', fakeGit({
      'rev-parse --show-toplevel': 'C:/w/repo',
      'remote get-url origin': 'git@github.com:me/repo.git',
      'rev-parse --abbrev-ref HEAD': 'main',
      'rev-parse HEAD': 'a'.repeat(40),
    }));
    expect(ctx).toMatchObject({ root: 'C:/w/repo', rootName: 'repo', remote: 'git@github.com:me/repo.git', branch: 'main', head: 'a'.repeat(40) });
    expect(repoContext('/nowhere', fakeGit({}))).toBeNull();
  });
  it('root hash is case-insensitive on win32 only', () => {
    expect(rootPathHash('C:/Work/Repo', 'win32')).toBe(rootPathHash('c:\\work\\repo', 'win32'));
    expect(rootPathHash('/home/Me/repo', 'linux')).not.toBe(rootPathHash('/home/me/repo', 'linux'));
  });
  it('reads head commit', () => {
    expect(headCommit('/r', fakeGit({ 'log -1 --format=%H%x09%s': 'abc1234def\tfeat: x' }))).toEqual({ sha: 'abc1234def', subject: 'feat: x' });
  });
});

describe('git: the HEAD reflog with times, and commits of this repo', () => {
  const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
  const entry = (sha: string, action: string, time = 1_000_000): ReflogEntry => ({ sha, time, action, subject: 'feat: x' });

  it('reflog reads the newest entries (sha, time from %gd under --date=unix, action, subject) in one bounded git call', () => {
    const seen: { args: string[]; timeout?: number }[] = [];
    const run = (_cwd: string, args: string[], timeout?: number) => {
      seen.push({ args, timeout });
      return `${B}\0HEAD@{1791512766}\0commit (amend): feat: x\0feat: x\n${A}\0HEAD@{1791512761}\0commit: feat: y\0feat: y`;
    };
    expect(reflog('/r', run, 1200)).toEqual([
      { sha: B, time: 1791512766000, action: 'commit (amend): feat: x', subject: 'feat: x' },
      { sha: A, time: 1791512761000, action: 'commit: feat: y', subject: 'feat: y' },
    ]);
    expect(seen).toEqual([{ args: ['log', '-g', '-n', '50', '--date=unix', '--format=%H%x00%gd%x00%gs%x00%s', 'HEAD'], timeout: 1200 }]);
    expect(reflog('/r', () => null)).toBeNull();
    expect(reflog('/r', () => 'garbage')).toBeNull();
    expect(reflog('/r', () => `${B}\0HEAD@{0}\0commit: x\0x`)).toEqual([{ sha: B, time: 0, action: 'commit: x', subject: 'x' }]);
  });

  it('amendedFrom: HEAD@{1} only when the newest reflog entry is a `commit (amend)` of that very commit', () => {
    expect(amendedFrom([entry(B, 'commit (amend): feat: x'), entry(A, 'commit: y')], B)).toBe(A);
    expect(amendedFrom([entry(B, 'commit: feat: x'), entry(A, 'commit: y')], B)).toBeNull();
    expect(amendedFrom([entry(B, 'commit (amend): feat: x'), entry(A, 'commit: y')], C)).toBeNull();
    expect(amendedFrom([entry(B, 'commit (amend): feat: x')], B)).toBeNull();
    expect(amendedFrom(null, B)).toBeNull();
  });

  it('real git: reflog, amend and resolveCommit after commit, amend, checkout, reset — and a commit of another repo never resolves', () => {
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const repo = tmp();
    const other = tmp();
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
    git(repo, 'init', '-q', '-b', 'main');
    git(other, 'init', '-q', '-b', 'main');
    git(other, 'commit', '-q', '--allow-empty', '-m', 'other');
    const foreign = git(other, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'a.txt'), '1');
    git(repo, 'add', '.');
    const t0 = Math.floor(Date.now() / 1000) * 1000;
    git(repo, 'commit', '-q', '-m', 'first');
    const first = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'a.txt'), '2');
    git(repo, 'commit', '-q', '-am', 'second: with a colon');
    const second = git(repo, 'rev-parse', 'HEAD');
    const log = reflog(repo)!;
    expect(log.map((e) => [e.sha, e.action, e.subject])).toEqual([
      [second, 'commit: second: with a colon', 'second: with a colon'], [first, 'commit (initial): first', 'first'],
    ]);
    expect(log.every((e) => e.time >= t0 - 1000 && e.time <= Date.now())).toBe(true);
    // resolveCommit: a short sha (as Claude Code's gitOperation gives it) → the full sha and subject — of THIS repo only
    expect(resolveCommit(repo, second.slice(0, 7))).toEqual({ sha: second, subject: 'second: with a colon' });
    expect(resolveCommit(repo, foreign.slice(0, 7))).toBeNull();
    expect(resolveCommit(repo, foreign)).toBeNull();
    expect(resolveCommit(repo, '0000000')).toBeNull();
    expect(resolveCommit(repo, '--all')).toBeNull();
    // a tree is not a commit
    expect(resolveCommit(repo, git(repo, 'rev-parse', 'HEAD^{tree}'))).toBeNull();
    git(repo, 'commit', '-q', '--amend', '-m', 'second, amended');
    const amended = git(repo, 'rev-parse', 'HEAD');
    expect(amendedFrom(reflog(repo), amended)).toBe(second);
    expect(amendedFrom(reflog(repo), second)).toBeNull();
    git(repo, 'checkout', '-q', '-b', 'feat', first);
    expect(reflog(repo)![0]).toMatchObject({ sha: first, action: expect.stringMatching(/^checkout: /) });
    expect(amendedFrom(reflog(repo), amended)).toBeNull(); // the reflog top is no longer the amend
    git(repo, 'reset', '-q', '--hard', amended);
    expect(reflog(repo)![0]).toMatchObject({ sha: amended, action: expect.stringMatching(/^reset: /) });
  });
});

describe('state', () => {
  it('saves, loads, removes per session; unsafe ids are sanitized', () => {
    const dir = tmp();
    saveState(dir, '../../evil id', { root: '/r', head: null, remote: null, disabled: false });
    expect(loadState(dir, '../../evil id')).toEqual({ root: '/r', head: null, remote: null, disabled: false });
    expect(existsSync(join(dir, 'state'))).toBe(true);
    expect(statSync(join(dir, 'state')).isDirectory()).toBe(true);
    removeState(dir, '../../evil id');
    expect(loadState(dir, '../../evil id')).toBeNull();
  });
});

describe('atomic writes', () => {
  it.skipIf(process.platform === 'win32')('writeConfig tightens a pre-existing world-readable config.json to 0600', () => {
    const env = { CONUS_CONFIG_DIR: tmp() };
    const file = join(env.CONUS_CONFIG_DIR, 'config.json');
    writeFileSync(file, '{}');
    chmodSync(file, 0o644);
    expect(statSync(file).mode & 0o777).toBe(0o644);
    writeConfig({ url: 'https://conus.example.com', token: 'tm_x', sendText: true }, env);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readConfig(env)).toEqual({ url: 'https://conus.example.com', token: 'tm_x', sendText: true });
  });
  it('leaves no temp files behind and replaces content in place of the old file', () => {
    const env = { CONUS_CONFIG_DIR: tmp() };
    writeConfig({ url: 'http://a', token: 'tm_1', sendText: true }, env);
    writeConfig({ url: 'http://b', token: 'tm_2', sendText: false }, env);
    expect(readdirSync(env.CONUS_CONFIG_DIR)).toEqual(['config.json']);
    expect(readConfig(env)).toEqual({ url: 'http://b', token: 'tm_2', sendText: false });
    const dir = tmp();
    saveState(dir, 's1', { root: '/r', head: null, remote: null, disabled: false });
    saveState(dir, 's1', { root: '/r2', head: 'h', remote: null, disabled: true });
    expect(readdirSync(join(dir, 'state'))).toEqual(['s1.json']);
    enqueue(dir, '/x', {});
    expect(readdirSync(dir).filter((f) => f !== 'state')).toHaveLength(1);
    expect(readdirSync(dir).some((f) => f.endsWith('.tmp'))).toBe(false);
  });
  it('removes its temp file when the rename fails', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'target.json'));
    expect(() => writeFileAtomic(join(dir, 'target.json'), 'x', 0o600)).toThrow();
    expect(readdirSync(dir)).toEqual(['target.json']);
  });
});

describe('atomic writes: win32 rename retry', () => {
  const fsError = (code: string) => Object.assign(new Error(`${code}: rename failed`), { code });
  const flakyRename = (codes: string[]) => {
    const attempts: string[] = [];
    const rename = (from: string, to: string) => {
      attempts.push(from);
      const code = codes.shift();
      if (code) throw fsError(code);
      renameSync(from, to);
    };
    return { rename, attempts };
  };

  it('retries EPERM from a target another process holds open, sleeping 10 then 20 ms, then succeeds', () => {
    const dir = tmp();
    const target = join(dir, 'state.json');
    writeFileSync(target, 'old');
    const { rename, attempts } = flakyRename(['EPERM', 'EPERM']);
    const t0 = Date.now();
    writeFileAtomic(target, 'new', undefined, { rename, platform: 'win32' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    expect(attempts).toHaveLength(3);
    expect(readFileSync(target, 'utf8')).toBe('new');
    expect(readdirSync(dir)).toEqual(['state.json']);
  });

  it('gives up after 5 attempts (waits 10/20/40/80 ms), rethrows and removes the temp file', () => {
    const dir = tmp();
    const target = join(dir, 'state.json');
    const { rename, attempts } = flakyRename(['EBUSY', 'EACCES', 'EPERM', 'EBUSY', 'EBUSY', 'EBUSY']);
    const waits: number[] = [];
    expect(() => writeFileAtomic(target, 'x', undefined, { rename, platform: 'win32', sleep: (ms) => waits.push(ms) }))
      .toThrow(expect.objectContaining({ code: 'EBUSY' }));
    expect(attempts).toHaveLength(5);
    expect(waits).toEqual([10, 20, 40, 80]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('does not retry on other platforms or for other error codes', () => {
    const dir = tmp();
    const target = join(dir, 'state.json');
    const posix = flakyRename(['EPERM']);
    expect(() => writeFileAtomic(target, 'x', undefined, { rename: posix.rename, platform: 'linux', sleep: () => {} })).toThrow();
    expect(posix.attempts).toHaveLength(1);
    const other = flakyRename(['ENOENT']);
    expect(() => writeFileAtomic(target, 'x', undefined, { rename: other.rename, platform: 'win32', sleep: () => {} })).toThrow();
    expect(other.attempts).toHaveLength(1);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('config robustness', () => {
  const withFile = (content: string) => {
    const env = { CONUS_CONFIG_DIR: tmp() };
    writeFileSync(join(env.CONUS_CONFIG_DIR, 'config.json'), content);
    return env;
  };
  it.each(['null', '[]', '5', '"str"', 'true', '{broken'])('treats config.json = %s as empty without throwing', (content) => {
    const env = withFile(content);
    expect(readConfig(env)).toBeNull();
    expect(readConfig({ ...env, CONUS_URL: 'http://localhost:1', CONUS_TOKEN: 'tm_env' })).toEqual({ url: 'http://localhost:1', token: 'tm_env', sendText: true });
  });
  it('uses url and token only when they are strings', () => {
    expect(readConfig(withFile('{"url":5,"token":"tm_x"}'))).toBeNull();
    expect(readConfig(withFile('{"url":"http://h","token":["tm_x"]}'))).toBeNull();
    expect(readConfig(withFile('{"url":"http://h","token":"tm_x"}'))).toEqual({ url: 'http://h', token: 'tm_x', sendText: true });
  });
  it('honours send_text only when it is a boolean; anything else means the default (true)', () => {
    expect(readConfig(withFile('{"url":"http://h","token":"t","send_text":false}'))?.sendText).toBe(false);
    expect(readConfig(withFile('{"url":"http://h","token":"t","send_text":true}'))?.sendText).toBe(true);
    expect(readConfig(withFile('{"url":"http://h","token":"t","send_text":"false"}'))?.sendText).toBe(true);
    expect(readConfig(withFile('{"url":"http://h","token":"t","send_text":0}'))?.sendText).toBe(true);
    expect(readConfig(withFile('{"url":"http://h","token":"t","send_text":null}'))?.sendText).toBe(true);
  });
});

describe('outbox status handling', () => {
  const apiThrowing = (status: number) => {
    const posted: string[] = [];
    const api = { post: async (p: string) => { posted.push(p); if (p === '/first') throw new ApiError(status, {}); return null; }, get: async () => ({}) } as any;
    return { api, posted };
  };
  it.each([401, 403, 404, 408, 429, 500, 502, 503])('keeps the event and stops the flush on %i', async (status) => {
    const dir = tmp();
    const now = Date.now();
    enqueue(dir, '/first', { n: 1 }, now - 1000);
    enqueue(dir, '/second', { n: 2 }, now);
    const { api, posted } = apiThrowing(status);
    expect(await flushOutbox(dir, api, 1000, now)).toEqual({ sent: 0, dropped: 0, left: 2 });
    expect(posted).toEqual(['/first']);
    expect(readdirSync(dir)).toHaveLength(2);
  });
  it.each([400, 409, 413, 422])('drops the event on %i and carries on', async (status) => {
    const dir = tmp();
    const now = Date.now();
    enqueue(dir, '/first', { n: 1 }, now - 1000);
    enqueue(dir, '/second', { n: 2 }, now);
    const { api, posted } = apiThrowing(status);
    expect(await flushOutbox(dir, api, 1000, now)).toEqual({ sent: 1, dropped: 1, left: 0 });
    expect(posted).toEqual(['/first', '/second']);
    expect(readdirSync(dir)).toHaveLength(0);
  });
});

describe('outbox: unknown sessions and concurrent flushes', () => {
  const unknown = () => new ApiError(409, { error: { code: 'unknown_session', message: 'x' } });

  it('an unknown_session reply keeps the event, holds back later events of that session, and lets other sessions through', async () => {
    const dir = tmp();
    const now = Date.now();
    enqueue(dir, '/activity', { agent_session_id: 's1', n: 1 }, now - 3000);
    enqueue(dir, '/activity', { agent_session_id: 's2', n: 2 }, now - 2000);
    enqueue(dir, '/activity', { agent_session_id: 's1', n: 3 }, now - 1000);
    const posted: unknown[] = [];
    const api = {
      post: async (_p: string, body: any) => { posted.push(body.n); if (body.agent_session_id === 's1') throw unknown(); return null; },
      get: async () => ({}),
    } as any;
    expect(await flushOutbox(dir, api, 1000, now)).toEqual({ sent: 1, dropped: 0, left: 2 });
    expect(posted).toEqual([1, 2]); // n=3 is never sent ahead of n=1
    expect(readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(2);
  });

  it('a direct post answered with unknown_session is retryable, a plain 409 is not', () => {
    expect(isPermanentRejection(unknown())).toBe(false);
    expect(isUnknownSession(unknown())).toBe(true);
    expect(isPermanentRejection(new ApiError(409, { error: { code: 'conflict' } }))).toBe(true);
    expect(isUnknownSession(new ApiError(409, null))).toBe(false);
  });

  it('drops an unknown_session event once it is older than an hour (its session/start never arrived)', async () => {
    const dir = tmp();
    const now = Date.now();
    enqueue(dir, '/activity', { agent_session_id: 'gone' }, now - 61 * 60_000);
    const api = { post: async () => { throw unknown(); }, get: async () => ({}) } as any;
    expect(await flushOutbox(dir, api, 1000, now)).toEqual({ sent: 0, dropped: 1, left: 0 });
    expect(readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(0);
  });

  it('only one process flushes at a time; a stale lock is taken over', async () => {
    const dir = tmp();
    enqueue(dir, '/a', { n: 1 });
    const posted: string[] = [];
    const api = { post: async (p: string) => { posted.push(p); return null; }, get: async () => ({}) } as any;
    writeFileSync(join(dir, '.flush.lock'), 'other');
    expect(await flushOutbox(dir, api, 1000)).toEqual({ sent: 0, dropped: 0, left: 1 });
    expect(posted).toEqual([]);
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dir, '.flush.lock'), old, old);
    expect(await flushOutbox(dir, api, 1000)).toEqual({ sent: 1, dropped: 0, left: 0 });
    expect(readdirSync(dir)).toEqual([]); // lock released
  });
});

describe('remote privacy', () => {
  const remoteOf = (remote: string) =>
    repoContext('/r', (_cwd, args) => (args.join(' ') === 'rev-parse --show-toplevel' ? '/r' : args.join(' ') === 'remote get-url origin' ? remote : null))!.remote;
  it('strips credentials from scheme URLs', () => {
    expect(remoteOf('https://user:s3cret@github.com/me/repo.git')).toBe('https://github.com/me/repo.git');
    expect(remoteOf('https://ghp_tokenonly@github.com/me/repo.git')).toBe('https://github.com/me/repo.git');
    expect(remoteOf('http://u:p%40ss@host:8080/x/y')).toBe('http://host:8080/x/y');
    expect(remoteOf('https://u:p@ss@host/x')).toBe('https://host/x');
    expect(remoteOf('ssh://git@github.com/me/repo.git')).toBe('ssh://github.com/me/repo.git');
  });
  it('leaves credential-free remotes and scp-style git@ remotes untouched', () => {
    expect(remoteOf('git@github.com:me/repo.git')).toBe('git@github.com:me/repo.git');
    expect(remoteOf('https://github.com/me/repo.git')).toBe('https://github.com/me/repo.git');
    expect(remoteOf('https://github.com/me/a@b.git')).toBe('https://github.com/me/a@b.git');
    expect(remoteOf('/srv/git/repo.git')).toBe('/srv/git/repo.git');
    expect(sanitizeRemote(null)).toBeNull();
  });
});
