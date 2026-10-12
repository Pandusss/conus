import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_BUDGET_MS, runHook, STALE_PREFIX, STOP_PREWORK_MS } from '../src/hook/run';
import { writeConfig } from '../src/config';
import type { ReflogEntry } from '../src/git';
import { isRepoDisabled, setRepoEnabled } from '../src/disable';

const here = dirname(fileURLToPath(import.meta.url));
const fxText = (p: string) => readFileSync(join(here, 'fixtures', p), 'utf8');

function setup(fetchImpl: typeof fetch, opts: { disabledRoot?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'conus-run-'));
  const root = mkdtempSync(join(tmpdir(), 'conus-repo-'));
  if (opts.disabledRoot) writeFileSync(join(root, '.conus.json'), '{"enabled": false}');
  const env = { CONUS_CONFIG_DIR: dir };
  writeConfig({ url: 'http://conus.test', token: 'tm_t', sendText: true }, env);
  let head = 'a'.repeat(40);
  // The repository as git answers: its commits (sha → subject), HEAD, and the HEAD reflog (newest first) with times.
  const subjects = new Map<string, string>([[head, 'feat: x']]);
  let log: ReflogEntry[] = [{ sha: head, time: Date.now() - 3_600_000, action: 'commit (initial): feat: x', subject: 'feat: x' }];
  const git = {
    repoContext: () => ({ root, rootName: 'repo', rootPathHash: 'h', remote: 'git@github.com:me/repo.git', branch: 'main', head }),
    headCommit: () => ({ sha: head, subject: subjects.get(head) ?? 'feat: x' }),
    reflog: () => log,
    resolveCommit: (_cwd: string, sha: string) => {
      const full = [...subjects.keys()].find((k) => k.startsWith(sha.toLowerCase()));
      return full ? { sha: full, subject: subjects.get(full)! } : null;
    },
  };
  return {
    dir, root, env, git,
    /**
     * HEAD moves to the commit `h` (this session's, another session's, or the user's) at `time`, recorded in the reflog as
     * `action`; `previous`, when given, is HEAD@{1}.
     */
    setHead: (h: string, action = 'commit: feat: x', previous: string | null = null, subject = 'feat: x', time = Date.now()) => {
      if (previous && log[0]?.sha !== previous) {
        subjects.set(previous, subjects.get(previous) ?? 'feat: x');
        log = [{ sha: previous, time: time - 600_000, action: 'commit: feat: x', subject: subjects.get(previous)! }, ...log];
      }
      head = h; subjects.set(h, subject);
      log = [{ sha: h, time, action, subject }, ...log];
    },
    savedHead: () => JSON.parse(readFileSync(join(dir, 'state', readdirSync(join(dir, 'state'))[0]!), 'utf8')).head as string | null,
  };
}

const calls: { url: string; body: any }[] = [];
const okFetch = (responses: Record<string, unknown>) => (async (url: string, init: any) => {
  calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
  const key = Object.keys(responses).find((k) => url.endsWith(k));
  const r = key ? responses[key] : null;
  return r === null ? new Response(null, { status: 204 }) : new Response(JSON.stringify(r), { status: 200 });
}) as unknown as typeof fetch;
const downFetch = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
const hangFetch = ((_u: string, init: any) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))))) as unknown as typeof fetch;

describe('runHook', () => {
  it('session-start: posts repo info, prints context, caches it, falls back to cache when down', async () => {
    const s = setup(okFetch({ '/session/start': { enabled: true, session_ref: 'S-1', project_key: 'REP', context: 'CTX-1' } }));
    const out = await runHook('claude', 'session-start', fxText('claude/session-start.json'), { env: s.env, fetchImpl: okFetch({ '/session/start': { enabled: true, session_ref: 'S-1', project_key: 'REP', context: 'CTX-1' } }), git: s.git });
    expect(out).toBe('CTX-1');
    const body = calls.at(-1)!.body;
    expect(body).toMatchObject({ agent_session_id: 'cc-123', source: 'startup', repo: { remote: 'git@github.com:me/repo.git', root_name: 'repo', branch: 'main' } });
    const down = await runHook('claude', 'session-start', fxText('claude/session-start.json'), { env: s.env, fetchImpl: downFetch, git: s.git });
    expect(down).toBe(STALE_PREFIX + 'CTX-1');
  });

  it('session-start with nothing cached and server down → empty', async () => {
    const s = setup(downFetch);
    expect(await runHook('codex', 'session-start', fxText('codex/session-start.json'), { env: s.env, fetchImpl: downFetch, git: s.git })).toBe('');
  });

  it('hanging server: prompt returns within ~1s, stop within ~5s, both empty', async () => {
    const s = setup(hangFetch);
    await runHook('claude', 'session-start', fxText('claude/session-start.json'), { env: s.env, fetchImpl: okFetch({ '/session/start': { context: 'C' } }), git: s.git });
    let t = Date.now();
    expect(await runHook('claude', 'prompt', fxText('claude/prompt.json'), { env: s.env, fetchImpl: hangFetch, git: s.git })).toBe('');
    expect(Date.now() - t).toBeLessThan(2500);
    t = Date.now();
    expect(await runHook('claude', 'stop', fxText('claude/stop.json'), { env: s.env, fetchImpl: hangFetch, git: s.git })).toBe('');
    expect(Date.now() - t).toBeLessThan(7000);
  }, 15_000);

  it('garbage stdin, BOM, missing config, untracked session, disabled repo → empty', async () => {
    const s = setup(okFetch({}));
    expect(await runHook('claude', 'prompt', 'not json', { env: s.env, fetchImpl: okFetch({}), git: s.git })).toBe('');
    expect(await runHook('claude', 'prompt', '\uFEFF' + fxText('claude/prompt.json'), { env: s.env, fetchImpl: okFetch({}), git: s.git })).toBe('');
    expect(await runHook('claude', 'session-start', fxText('claude/session-start.json'), { env: { CONUS_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'none-')) }, fetchImpl: okFetch({}), git: s.git })).toBe('');
    const d = setup(okFetch({}), { disabledRoot: true });
    expect(await runHook('claude', 'session-start', fxText('claude/session-start.json'), { env: d.env, fetchImpl: okFetch({ '/session/start': { context: 'C' } }), git: d.git })).toBe('');
  });

  it('prompt → status line; stop → block JSON for claude (transcript) and codex', async () => {
    const s = setup(okFetch({}));
    const f = okFetch({ '/session/start': { context: 'C' }, '/turn/prompt': { status_line: '[conus S-1 · REP · в работе: —]' }, '/turn/stop': { action: 'nudge', reason: 'Закрой REP-1.' } });
    await runHook('claude', 'session-start', fxText('claude/session-start.json'), { env: s.env, fetchImpl: f, git: s.git });
    const p = JSON.parse(await runHook('claude', 'prompt', fxText('claude/prompt.json'), { env: s.env, fetchImpl: f, git: s.git }));
    expect(p.hookSpecificOutput.additionalContext).toBe('[conus S-1 · REP · в работе: —]');
    expect(calls.at(-1)!.body.prompt_excerpt).toBe('Добавь импорт CSV');
    const stopIn = fxText('claude/stop.json').replace('__TRANSCRIPT__', join(here, 'fixtures/claude/transcript.jsonl').replace(/\\/g, '\\\\'));
    expect(JSON.parse(await runHook('claude', 'stop', stopIn, { env: s.env, fetchImpl: f, git: s.git }))).toEqual({ decision: 'block', reason: 'Закрой REP-1.' });
    // A real Claude Code Stop carries last_assistant_message; it wins over the transcript.
    expect(calls.at(-1)!.body.answer_excerpt).toBe('Импорт CSV добавлен в src/import.ts, npm test проходит.');
    const oldStopIn = fxText('claude/stop-transcript-only.json').replace('__TRANSCRIPT__', join(here, 'fixtures/claude/transcript.jsonl').replace(/\\/g, '\\\\'));
    await runHook('claude', 'stop', oldStopIn, { env: s.env, fetchImpl: f, git: s.git });
    expect(calls.at(-1)!.body.answer_excerpt).toBe('Готово: импорт добавлен, тесты проходят.');
    await runHook('codex', 'session-start', fxText('codex/session-start.json'), { env: s.env, fetchImpl: f, git: s.git });
    expect(JSON.parse(await runHook('codex', 'stop', fxText('codex/stop.json'), { env: s.env, fetchImpl: f, git: s.git })).decision).toBe('block');
  });

  it('tool: posts facts; queues on failure and flushes on the next hook; skips irrelevant tools', async () => {
    const s = setup(okFetch({}));
    await runHook('claude', 'session-start', fxText('claude/session-start.json'), { env: s.env, fetchImpl: okFetch({ '/session/start': { context: 'C' } }), git: s.git });
    const edit = fxText('claude/tool-edit.json').replace(/C:\\\\Users\\\\me\\\\repo/g, s.root.replace(/\\/g, '\\\\'));
    expect(await runHook('claude', 'tool', edit, { env: s.env, fetchImpl: downFetch, git: s.git })).toBe('');
    expect(readdirSync(join(s.dir, 'outbox'))).toHaveLength(1);
    const before = calls.length;
    await runHook('claude', 'tool', edit, { env: s.env, fetchImpl: okFetch({}), git: s.git });
    const sent = calls.slice(before).filter((c) => c.url.endsWith('/activity'));
    expect(sent).toHaveLength(2);
    expect(sent[0]!.body.facts).toEqual([{ kind: 'file_edit', data: { path: 'src/import.ts' } }]);
    expect(readdirSync(join(s.dir, 'outbox'))).toHaveLength(0);
    const read = JSON.stringify({ session_id: 'cc-123', cwd: s.root, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'x' } });
    const n = calls.length;
    await runHook('claude', 'tool', read, { env: s.env, fetchImpl: okFetch({}), git: s.git });
    expect(calls.length).toBe(n);
  });

  it('session-end posts and removes local state', async () => {
    const s = setup(okFetch({}));
    await runHook('codex', 'session-start', fxText('codex/session-start.json'), { env: s.env, fetchImpl: okFetch({ '/session/start': { context: 'C' } }), git: s.git });
    await runHook('codex', 'session-end', fxText('codex/session-end.json'), { env: s.env, fetchImpl: okFetch({}), git: s.git });
    expect(calls.at(-1)!.url).toBe('http://conus.test/api/hooks/session/end');
    expect(readdirSync(join(s.dir, 'state'))).toHaveLength(0);
  });
});

describe('runHook: session-end idempotency', () => {
  const start = (s: ReturnType<typeof setup>, fetchImpl: typeof fetch) =>
    runHook('codex', 'session-start', fxText('codex/session-start.json'), { env: s.env, fetchImpl, git: s.git });
  const end = (s: ReturnType<typeof setup>, fetchImpl: typeof fetch) =>
    runHook('codex', 'session-end', fxText('codex/session-end.json'), { env: s.env, fetchImpl, git: s.git });
  const lastEndKey = () => calls.filter((c) => c.url.endsWith('/session/end')).at(-1)!.body.idempotency_key as string;

  it('a resumed session (same agent_session_id) ends with a fresh key each time', async () => {
    const s = setup(okFetch({}));
    const f = okFetch({ '/session/start': { context: 'C' } });
    await start(s, f);
    await end(s, f);
    const first = lastEndKey();
    await start(s, f);
    await end(s, f);
    const second = lastEndKey();
    expect(first).toMatch(/^[0-9a-f]{40}$/);
    expect(second).not.toBe(first);
  });

  it('a queued session-end replays with the key it was created with', async () => {
    const s = setup(okFetch({}));
    const f = okFetch({ '/session/start': { context: 'C' } });
    await start(s, f);
    expect(await end(s, downFetch)).toBe('');
    expect(readdirSync(join(s.dir, 'state'))).toHaveLength(0);
    const queued = readdirSync(join(s.dir, 'outbox'));
    expect(queued).toHaveLength(1);
    const stored = JSON.parse(readFileSync(join(s.dir, 'outbox', queued[0]!), 'utf8'));
    expect(stored.path).toBe('/api/hooks/session/end');
    await start(s, f); // the next hook flushes the outbox
    expect(lastEndKey()).toBe(stored.body.idempotency_key);
    expect(readdirSync(join(s.dir, 'outbox'))).toHaveLength(0);
  });
});

describe('runHook: server down or slow (review focus #4)', () => {
  const timed = async (p: Promise<string>) => { const t = Date.now(); const out = await p; return { out, ms: Date.now() - t }; };

  it('hanging server: session-start serves the stale snapshot within ~3s, tool and session-end queue within their timeouts', async () => {
    const a = setup(hangFetch);
    const b = setup(hangFetch);
    const c = setup(hangFetch);
    const ok = okFetch({ '/session/start': { context: 'CTX-H' } });
    for (const s of [a, b, c]) await runHook('claude', 'session-start', fxText('claude/session-start.json'), { env: s.env, fetchImpl: ok, git: s.git });
    const edit = fxText('claude/tool-edit.json').replace(/C:\\\\Users\\\\me\\\\repo/g, b.root.replace(/\\/g, '\\\\'));
    const [start, tool, end] = await Promise.all([
      timed(runHook('claude', 'session-start', fxText('claude/session-start.json'), { env: a.env, fetchImpl: hangFetch, git: a.git })),
      timed(runHook('claude', 'tool', edit, { env: b.env, fetchImpl: hangFetch, git: b.git })),
      timed(runHook('claude', 'session-end', fxText('claude/session-end.json'), { env: c.env, fetchImpl: hangFetch, git: c.git })),
    ]);
    expect(start.out).toBe(STALE_PREFIX + 'CTX-H');
    expect(start.ms).toBeLessThan(4500);
    expect(tool.out).toBe('');
    expect(tool.ms).toBeLessThan(3500);
    expect(readdirSync(join(b.dir, 'outbox'))).toHaveLength(1);
    expect(end.out).toBe('');
    expect(end.ms).toBeLessThan(2500);
    expect(readdirSync(join(c.dir, 'outbox'))).toHaveLength(1);
    expect(readdirSync(join(c.dir, 'state'))).toHaveLength(0);
  }, 15_000);

  it('unreachable URL with the real fetch: prompt and stop return empty within their timeouts', async () => {
    const s = setup(okFetch({}));
    await runHook('claude', 'session-start', fxText('claude/session-start.json'), { env: s.env, fetchImpl: okFetch({ '/session/start': { context: 'C' } }), git: s.git });
    writeConfig({ url: 'http://127.0.0.1:1', token: 'tm_t', sendText: true }, s.env);
    const prompt = await timed(runHook('claude', 'prompt', fxText('claude/prompt.json'), { env: s.env, git: s.git }));
    expect(prompt.out).toBe('');
    expect(prompt.ms).toBeLessThan(2500);
    const stop = await timed(runHook('claude', 'stop', fxText('claude/stop.json'), { env: s.env, git: s.git }));
    expect(stop.out).toBe('');
    expect(stop.ms).toBeLessThan(7000);
  }, 15_000);

  it('never throws and still serves the context when the config dir cannot be written', async () => {
    const s = setup(okFetch({}));
    const blocked = join(s.dir, 'blocked');
    writeFileSync(blocked, 'a file, not a directory');
    const env = { CONUS_CONFIG_DIR: blocked, CONUS_URL: 'http://conus.test', CONUS_TOKEN: 'tm_t' };
    expect(await runHook('claude', 'session-start', fxText('claude/session-start.json'), { env, fetchImpl: okFetch({ '/session/start': { context: 'C' } }), git: s.git })).toBe('C');
  });
});

describe('runHook: fix round 1', () => {
  const start = (s: ReturnType<typeof setup>, agent: 'claude' | 'codex' = 'claude', context = 'C') =>
    runHook(agent, 'session-start', fxText(`${agent}/session-start.json`), { env: s.env, fetchImpl: okFetch({ '/session/start': { context } }), git: s.git });
  const statusFetch = (status: number) => (async (url: string, init: any) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    return new Response('{"error":{"code":"x"}}', { status });
  }) as unknown as typeof fetch;
  const queued = (s: ReturnType<typeof setup>) => (existsSync(join(s.dir, 'outbox')) ? readdirSync(join(s.dir, 'outbox')).length : 0);
  const logText = (s: ReturnType<typeof setup>) => readFileSync(join(s.dir, 'logs', 'hook.log'), 'utf8');
  const editIn = (s: ReturnType<typeof setup>) => fxText('claude/tool-edit.json').replace(/C:\\\\Users\\\\me\\\\repo/g, s.root.replace(/\\/g, '\\\\'));

  it('session-start sends cwd relative to the repo root, never the absolute path', async () => {
    const s = setup(okFetch({}));
    const payload = (cwd: string) => JSON.stringify({ ...JSON.parse(fxText('claude/session-start.json')), cwd });
    const f = okFetch({ '/session/start': { context: 'C' } });
    const bodies: any[] = [];
    for (const cwd of [s.root, join(s.root, 'packages', 'cli'), 'C:\\Users\\me\\repo']) {
      await runHook('claude', 'session-start', payload(cwd), { env: s.env, fetchImpl: f, git: s.git });
      bodies.push(calls.at(-1)!.body);
    }
    expect(bodies.map((b) => b.cwd)).toEqual(['.', 'packages/cli', '.']);
    const json = JSON.stringify(bodies);
    for (const abs of [s.root, s.root.replace(/\\/g, '/'), tmpdir(), 'C:\\Users\\me']) expect(json).not.toContain(JSON.stringify(abs).slice(1, -1));
  });

  it('session-start still contacts the server and serves context (and the cache) when local state cannot be saved', async () => {
    const s = setup(okFetch({}));
    writeFileSync(join(s.dir, 'state'), 'a file where the state directory should be');
    expect(await start(s, 'claude', 'CTX-S')).toBe('CTX-S');
    expect(await runHook('claude', 'session-start', fxText('claude/session-start.json'), { env: s.env, fetchImpl: downFetch, git: s.git })).toBe(STALE_PREFIX + 'CTX-S');
  });

  it('tool (Codex): HEAD is recorded only after its commit was posted or queued', async () => {
    const s = setup(okFetch({}));
    await start(s, 'codex');
    // Codex has no gitOperation: a `git commit` command and the new HEAD are its only evidence.
    const commit = JSON.stringify({
      session_id: '019a0000-aaaa', cwd: 'C:\\Users\\me\\repo', hook_event_name: 'PostToolUse', turn_id: 'turn-1', tool_name: 'shell',
      tool_input: { command: ['bash', '-lc', 'git commit -am "feat: x"'] }, tool_response: 'Exit code: 0\nOutput:\nok',
    });
    const commitFacts = (from: number) => calls.slice(from).filter((c) => c.url.endsWith('/activity')).map((c) => c.body.facts);
    // Neither sent nor queued (outbox path blocked): HEAD must stay unrecorded so the commit is reported later.
    s.setHead('b'.repeat(40));
    writeFileSync(join(s.dir, 'outbox'), 'blocks the outbox');
    expect(await runHook('codex', 'tool', commit, { env: s.env, fetchImpl: downFetch, git: s.git })).toBe('');
    rmSync(join(s.dir, 'outbox'));
    let from = calls.length;
    await runHook('codex', 'tool', commit, { env: s.env, fetchImpl: okFetch({}), git: s.git });
    expect(commitFacts(from)).toEqual([[{ kind: 'git_commit', data: { sha: 'b'.repeat(40), subject: 'feat: x' } }]]);
    // Posted: the same HEAD is not reported again.
    from = calls.length;
    await runHook('codex', 'tool', commit, { env: s.env, fetchImpl: okFetch({}), git: s.git });
    expect(commitFacts(from)).toEqual([]);
    // Queued: recorded too, so the same HEAD is not reported a second time (the next hook only flushes the queued report).
    s.setHead('c'.repeat(40));
    await runHook('codex', 'tool', commit, { env: s.env, fetchImpl: downFetch, git: s.git });
    const files = readdirSync(join(s.dir, 'outbox'));
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(s.dir, 'outbox', files[0]!), 'utf8')).body.facts)
      .toEqual([{ kind: 'git_commit', data: { sha: 'c'.repeat(40), subject: 'feat: x' } }]);
    from = calls.length;
    await runHook('codex', 'tool', commit, { env: s.env, fetchImpl: okFetch({}), git: s.git });
    expect(commitFacts(from)).toEqual([[{ kind: 'git_commit', data: { sha: 'c'.repeat(40), subject: 'feat: x' } }]]);
    from = calls.length;
    await runHook('codex', 'tool', commit, { env: s.env, fetchImpl: okFetch({}), git: s.git });
    expect(commitFacts(from)).toEqual([]);
  });

  it('session-end removes local state even when the event can be neither sent nor queued', async () => {
    const s = setup(okFetch({}));
    await start(s, 'codex');
    writeFileSync(join(s.dir, 'outbox'), 'blocks the outbox');
    expect(await runHook('codex', 'session-end', fxText('codex/session-end.json'), { env: s.env, fetchImpl: downFetch, git: s.git })).toBe('');
    expect(readdirSync(join(s.dir, 'state'))).toHaveLength(0);
  });

  it('never throws when the config dir cannot even be resolved', async () => {
    const env = new Proxy({}, { get() { throw new Error('env unavailable'); } }) as NodeJS.ProcessEnv;
    expect(await runHook('claude', 'prompt', fxText('claude/prompt.json'), { env, fetchImpl: okFetch({}), git: setup(okFetch({})).git })).toBe('');
  });

  it('logs a fixed message for invalid stdin, never the parser message (it echoes the payload)', async () => {
    const s = setup(okFetch({}));
    expect(await runHook('claude', 'prompt', 'SECRET-PROMPT is not json', { env: s.env, fetchImpl: okFetch({}), git: s.git })).toBe('');
    expect(logText(s)).toContain('stdin is not valid JSON');
    expect(logText(s)).not.toContain('SECRET');
  });

  it('a BOM-prefixed payload of a tracked session still gets its status line', async () => {
    const s = setup(okFetch({}));
    await start(s);
    const f = okFetch({ '/turn/prompt': { status_line: 'S-BOM' } });
    const out = await runHook('claude', 'prompt', '\uFEFF' + fxText('claude/prompt.json'), { env: s.env, fetchImpl: f, git: s.git });
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toBe('S-BOM');
  });

  it('tool: caps facts per post at 200 and logs the truncation', async () => {
    const s = setup(okFetch({}));
    await start(s);
    const adds = Array.from({ length: 250 }, (_, i) => `*** Add File: src/f${i}.ts\n+x`).join('\n');
    const payload = JSON.stringify({ session_id: 'cc-123', cwd: s.root, hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: { input: `*** Begin Patch\n${adds}\n*** End Patch` } });
    await runHook('claude', 'tool', payload, { env: s.env, fetchImpl: okFetch({}), git: s.git });
    const facts = calls.at(-1)!.body.facts;
    expect(facts).toHaveLength(200);
    expect(facts[0]).toEqual({ kind: 'file_edit', data: { path: 'src/f0.ts' } });
    expect(logText(s)).toMatch(/250 facts.*truncated to 200/);
  });

  it('tool: the cap drops file edits, never the git_commit', async () => {
    const s = setup(okFetch({}));
    await start(s);
    s.setHead('d'.repeat(40));
    const adds = Array.from({ length: 250 }, (_, i) => `*** Add File: src/g${i}.ts\n+x`).join('\n');
    const script = `apply_patch <<'EOF'\n*** Begin Patch\n${adds}\n*** End Patch\nEOF\ngit commit -am "add files"`;
    const payload = JSON.stringify({
      session_id: 'cc-123', cwd: s.root, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: script },
      tool_response: { stdout: '', stderr: '', interrupted: false, gitOperation: { commit: { sha: 'ddddddd', kind: 'committed', branch: 'main' } } },
    });
    await runHook('claude', 'tool', payload, { env: s.env, fetchImpl: okFetch({}), git: s.git });
    const facts = calls.at(-1)!.body.facts as { kind: string }[];
    expect(facts.length).toBeLessThanOrEqual(200);
    expect(facts.filter((f) => f.kind === 'git_commit')).toEqual([{ kind: 'git_commit', data: { sha: 'd'.repeat(40), subject: 'feat: x', branch: 'main' } }]);
    expect(facts.filter((f) => f.kind === 'file_edit')).toHaveLength(199);
  });

  it.each([400, 409, 413, 422])('a direct post rejected with %i is dropped, not queued', async (status) => {
    const s = setup(okFetch({}));
    await start(s);
    await runHook('claude', 'tool', editIn(s), { env: s.env, fetchImpl: statusFetch(status), git: s.git });
    expect(queued(s)).toBe(0);
    await runHook('claude', 'session-end', fxText('claude/session-end.json'), { env: s.env, fetchImpl: statusFetch(status), git: s.git });
    expect(queued(s)).toBe(0);
    expect(readdirSync(join(s.dir, 'state'))).toHaveLength(0);
  });

  it.each([401, 404, 408, 429, 503])('a direct post failing with %i is queued for retry', async (status) => {
    const s = setup(okFetch({}));
    await start(s);
    await runHook('claude', 'tool', editIn(s), { env: s.env, fetchImpl: statusFetch(status), git: s.git });
    expect(queued(s)).toBe(1);
    await runHook('claude', 'session-end', fxText('claude/session-end.json'), { env: s.env, fetchImpl: statusFetch(status), git: s.git });
    expect(queued(s)).toBe(2);
  });
});

describe('runHook: acceptance review (Task 21)', () => {
  const start = (s: ReturnType<typeof setup>, agent: 'claude' | 'codex' = 'claude') =>
    runHook(agent, 'session-start', fxText(`${agent}/session-start.json`), { env: s.env, fetchImpl: okFetch({ '/session/start': { context: 'C' } }), git: s.git });
  const bash = (command: string, gitOperation: unknown) => JSON.stringify({
    ...JSON.parse(fxText('claude/tool-bash-commit.json')), tool_input: { command, description: 'commit' },
    tool_response: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, gitOperation },
  });
  const activity = (from: number) => calls.slice(from).filter((c) => c.url.endsWith('/activity')).map((c) => c.body.facts);

  it('tool: a Claude commit named by gitOperation; an amend carries HEAD@{1} when the reflog top is that commit\'s `commit (amend)`', async () => {
    const s = setup(okFetch({}));
    await start(s);
    s.setHead('b'.repeat(40), 'commit: @ x', 'a'.repeat(40), '@ x', Date.now() - 60_000);
    let from = calls.length;
    await runHook('claude', 'tool', bash('git commit -m "@ x"', { commit: { sha: 'bbbbbbb', kind: 'committed', branch: 'main' } }), { env: s.env, fetchImpl: okFetch({}), git: s.git });
    expect(activity(from)).toEqual([[{ kind: 'git_commit', data: { sha: 'b'.repeat(40), subject: '@ x', branch: 'main' } }]]);
    s.setHead('c'.repeat(40), 'commit (amend): x', 'b'.repeat(40), 'x');
    from = calls.length;
    await runHook('claude', 'tool', bash("git commit --amend -F - <<'EOF'\nx\nEOF", { commit: { sha: 'ccccccc', kind: 'amended', branch: 'main' } }), { env: s.env, fetchImpl: okFetch({}), git: s.git });
    expect(activity(from)).toEqual([[{ kind: 'git_commit', data: { sha: 'c'.repeat(40), subject: 'x', branch: 'main', amends: 'b'.repeat(40) } }]]);
  });

  it('tool: `amends` only while the reflog top is that commit\'s `commit (amend)`; a stale saved HEAD never counts', async () => {
    const s = setup(okFetch({}));
    await start(s); // saved HEAD 'a' * 40, but HEAD@{1} is 'e' * 40
    s.setHead('c'.repeat(40), 'commit (amend): x', 'e'.repeat(40), 'feat: x', Date.now() - 60_000);
    let from = calls.length;
    await runHook('claude', 'tool', bash('git commit --amend --no-edit', { commit: { sha: 'ccccccc', kind: 'amended', branch: 'main' } }), { env: s.env, fetchImpl: okFetch({}), git: s.git });
    expect(activity(from)).toEqual([[{ kind: 'git_commit', data: { sha: 'c'.repeat(40), subject: 'feat: x', branch: 'main', amends: 'e'.repeat(40) } }]]);
    // the reflog top is a plain commit, whatever gitOperation says: no amends
    s.setHead('d'.repeat(40), 'commit: x', 'c'.repeat(40));
    from = calls.length;
    await runHook('claude', 'tool', bash('git commit --amend --no-edit', { commit: { sha: 'ddddddd', kind: 'amended', branch: 'main' } }), { env: s.env, fetchImpl: okFetch({}), git: s.git });
    expect(activity(from)).toEqual([[{ kind: 'git_commit', data: { sha: 'd'.repeat(40), subject: 'feat: x', branch: 'main' } }]]);
    // an amend, but another commit has moved HEAD since (after the call): the reflog top is not this commit, no amends
    s.setHead('9'.repeat(40), 'commit: other', 'd'.repeat(40), 'other', Date.now() + 60_000);
    from = calls.length;
    await runHook('claude', 'tool', bash('git commit --amend --no-edit', { commit: { sha: 'ddddddd', kind: 'amended', branch: 'main' } }), { env: s.env, fetchImpl: okFetch({}), git: s.git });
    expect(activity(from)).toEqual([[{ kind: 'git_commit', data: { sha: 'd'.repeat(40), subject: 'feat: x', branch: 'main' } }]]);
  });

  it('tool: a Claude `git commit` that created nothing reports nothing — another session\'s earlier commit is never taken (repro 3)', async () => {
    const s = setup(okFetch({}));
    await start(s);
    s.setHead('e'.repeat(40), 'commit: feat: from A', 'a'.repeat(40), 'feat: from A', Date.now() - 60_000); // another session's commit
    const from = calls.length;
    const noop = JSON.stringify({ session_id: 'cc-123', cwd: 'C:\\Users\\me\\repo', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git commit -m x; git status' }, tool_response: { stdout: 'nothing to commit, working tree clean', stderr: '', interrupted: false }, duration_ms: 300 });
    await runHook('claude', 'tool', noop, { env: s.env, fetchImpl: okFetch({}), git: s.git });
    expect(activity(from)).toEqual([]);
  });

  it('stop: sends the model of the Claude transcript (SessionStart carries none), null without a transcript', async () => {
    const s = setup(okFetch({}));
    await start(s);
    const stopIn = (p: string) => fxText('claude/stop.json').replace('__TRANSCRIPT__', p.replace(/\\/g, '\\\\'));
    await runHook('claude', 'stop', stopIn(join(here, 'fixtures/claude/transcript.jsonl')), { env: s.env, fetchImpl: okFetch({ '/turn/stop': { action: 'ok' } }), git: s.git });
    expect(calls.at(-1)!.body).toMatchObject({ model: 'claude-opus-5', answer_excerpt: 'Импорт CSV добавлен в src/import.ts, npm test проходит.' });
    await runHook('claude', 'stop', stopIn(join(s.dir, 'missing.jsonl')), { env: s.env, fetchImpl: okFetch({ '/turn/stop': { action: 'ok' } }), git: s.git });
    expect(calls.at(-1)!.body.model).toBeNull();
  });

  it('stop: the model goes to the server even when text sending is off', async () => {
    const s = setup(okFetch({}));
    writeConfig({ url: 'http://conus.test', token: 'tm_t', sendText: false }, s.env);
    await start(s);
    const stopIn = fxText('claude/stop.json').replace('__TRANSCRIPT__', join(here, 'fixtures/claude/transcript.jsonl').replace(/\\/g, '\\\\'));
    await runHook('claude', 'stop', stopIn, { env: s.env, fetchImpl: okFetch({ '/turn/stop': { action: 'ok' } }), git: s.git });
    expect(calls.at(-1)!.body).toMatchObject({ model: 'claude-opus-5', answer_excerpt: null });
  });

  it('stop: a Codex payload model is used as is', async () => {
    const s = setup(okFetch({}));
    await start(s, 'codex');
    const stopIn = JSON.stringify({ ...JSON.parse(fxText('codex/stop.json')), model: 'gpt-5.5-codex' });
    await runHook('codex', 'stop', stopIn, { env: s.env, fetchImpl: okFetch({ '/turn/stop': { action: 'ok' } }), git: s.git });
    expect(calls.at(-1)!.body.model).toBe('gpt-5.5-codex');
  });
});

describe('runHook: failed session/start, flush on every hook, unknown sessions (final fix I2)', () => {
  const statusFetch = (status: number, body: unknown = { error: { code: 'x' } }) => (async (url: string, init: any) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  const queuedItems = (s: ReturnType<typeof setup>) => {
    const dir = join(s.dir, 'outbox');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
  };
  const startIn = fxText('claude/session-start.json');
  const editIn = (s: ReturnType<typeof setup>) => fxText('claude/tool-edit.json').replace(/C:\\\\Users\\\\me\\\\repo/g, s.root.replace(/\\/g, '\\\\'));
  const cachedCtx = '<task-manager session="S-0ld1" project="REP" agent="a">\nCORE\n</task-manager>';
  const paths = (from: number) => calls.slice(from).map((c) => c.url.replace('http://conus.test', ''));
  const timed = async (p: Promise<string>) => { const t = Date.now(); const out = await p; return { out, ms: Date.now() - t }; };

  it.each([
    ['a network error', downFetch],
    ['500', statusFetch(500)],
    ['503', statusFetch(503)],
    ['429', statusFetch(429, { error: { code: 'rate_limited' } })],
  ])('session-start failing with %s queues its body and serves the cache without the old session ref', async (_name, failing) => {
    const s = setup(okFetch({}));
    await runHook('claude', 'session-start', startIn, { env: s.env, fetchImpl: okFetch({ '/session/start': { context: cachedCtx } }), git: s.git });
    const out = await runHook('claude', 'session-start', startIn, { env: s.env, fetchImpl: failing, git: s.git });
    expect(out).toBe(STALE_PREFIX + '<task-manager project="REP" agent="a">\nCORE\n</task-manager>');
    expect(out).not.toContain('S-0ld1');
    const q = queuedItems(s);
    expect(q).toHaveLength(1);
    expect(q[0].path).toBe('/api/hooks/session/start');
    expect(q[0].body).toMatchObject({ agent_session_id: 'cc-123', source: 'startup', cwd: '.', repo: { root_name: 'repo', branch: 'main' } });
  });

  it('a cached status line loses its session ref too', async () => {
    const s = setup(okFetch({}));
    await runHook('claude', 'session-start', startIn, { env: s.env, fetchImpl: okFetch({ '/session/start': { context: '[conus S-0ld1 · REP · в работе: —]' } }), git: s.git });
    expect(await runHook('claude', 'session-start', startIn, { env: s.env, fetchImpl: downFetch, git: s.git })).toBe(STALE_PREFIX + '[conus REP · в работе: —]');
  });

  it('session-start timing out is queued and still answers within its 3 s budget', async () => {
    const s = setup(okFetch({}));
    await runHook('claude', 'session-start', startIn, { env: s.env, fetchImpl: okFetch({ '/session/start': { context: 'C' } }), git: s.git });
    const r = await timed(runHook('claude', 'session-start', startIn, { env: s.env, fetchImpl: hangFetch, git: s.git }));
    expect(r.out).toBe(STALE_PREFIX + 'C');
    expect(r.ms).toBeLessThan(3800);
    expect(queuedItems(s).map((q) => q.path)).toEqual(['/api/hooks/session/start']);
  }, 10_000);

  it('session-start rejected as invalid (400) is not queued', async () => {
    const s = setup(okFetch({}));
    await runHook('claude', 'session-start', startIn, { env: s.env, fetchImpl: statusFetch(400), git: s.git });
    expect(queuedItems(s)).toEqual([]);
  });

  it('every hook flushes the queue first, oldest first, before its own request', async () => {
    const s = setup(okFetch({}));
    await runHook('claude', 'session-start', startIn, { env: s.env, fetchImpl: downFetch, git: s.git }); // start queued
    await runHook('claude', 'tool', editIn(s), { env: s.env, fetchImpl: downFetch, git: s.git }); // activity queued
    expect(queuedItems(s).map((q) => q.path)).toEqual(['/api/hooks/session/start', '/api/hooks/activity']);
    let from = calls.length;
    const prompt = await runHook('claude', 'prompt', fxText('claude/prompt.json'), { env: s.env, fetchImpl: okFetch({ '/turn/prompt': { status_line: 'L' } }), git: s.git });
    expect(JSON.parse(prompt).hookSpecificOutput.additionalContext).toBe('L');
    expect(paths(from)).toEqual(['/api/hooks/session/start', '/api/hooks/activity', '/api/hooks/turn/prompt']);
    expect(queuedItems(s)).toEqual([]);
    for (const [event, own] of [['stop', '/api/hooks/turn/stop'], ['session-end', '/api/hooks/session/end']] as const) {
      await runHook('claude', 'tool', editIn(s), { env: s.env, fetchImpl: downFetch, git: s.git });
      from = calls.length;
      await runHook('claude', event, fxText(`claude/${event}.json`).replace('__TRANSCRIPT__', ''), { env: s.env, fetchImpl: okFetch({ '/turn/stop': { action: 'ok' } }), git: s.git });
      expect(paths(from)).toEqual(['/api/hooks/activity', own]);
      expect(queuedItems(s)).toEqual([]);
    }
  });

  it('the flush is bounded: with a queue and a hanging server every hook stays within its budget', async () => {
    const s = setup(okFetch({}));
    await runHook('claude', 'session-start', startIn, { env: s.env, fetchImpl: okFetch({ '/session/start': { context: 'C' } }), git: s.git });
    await runHook('claude', 'tool', editIn(s), { env: s.env, fetchImpl: downFetch, git: s.git });
    const prompt = await timed(runHook('claude', 'prompt', fxText('claude/prompt.json'), { env: s.env, fetchImpl: hangFetch, git: s.git }));
    expect(prompt.out).toBe('');
    expect(prompt.ms).toBeLessThan(1700);
    const tool = await timed(runHook('claude', 'tool', editIn(s), { env: s.env, fetchImpl: hangFetch, git: s.git }));
    expect(tool.ms).toBeLessThan(2700);
    const end = await timed(runHook('claude', 'session-end', fxText('claude/session-end.json'), { env: s.env, fetchImpl: hangFetch, git: s.git }));
    expect(end.ms).toBeLessThan(1700);
    expect(queuedItems(s).map((q) => q.path)).toEqual(['/api/hooks/activity', '/api/hooks/activity', '/api/hooks/session/end']);
  }, 15_000);

  it('activity the server cannot place yet (409 unknown_session) is queued and replayed after the start', async () => {
    // a plain 409 is still a permanent rejection
    const plain = setup(okFetch({}));
    await runHook('claude', 'session-start', startIn, { env: plain.env, fetchImpl: okFetch({ '/session/start': { context: 'C' } }), git: plain.git });
    await runHook('claude', 'tool', editIn(plain), { env: plain.env, fetchImpl: statusFetch(409), git: plain.git });
    expect(queuedItems(plain)).toEqual([]);

    const s = setup(okFetch({}));
    await runHook('claude', 'session-start', startIn, { env: s.env, fetchImpl: okFetch({ '/session/start': { context: 'C' } }), git: s.git });
    await runHook('claude', 'tool', editIn(s), { env: s.env, fetchImpl: statusFetch(409, { error: { code: 'unknown_session', message: 'm' } }), git: s.git });
    expect(queuedItems(s).map((q) => q.path)).toEqual(['/api/hooks/activity']);
    const from = calls.length;
    await runHook('claude', 'prompt', fxText('claude/prompt.json'), { env: s.env, fetchImpl: okFetch({}), git: s.git });
    expect(paths(from)).toEqual(['/api/hooks/activity', '/api/hooks/turn/prompt']);
    expect(queuedItems(s)).toEqual([]);
  });
});

describe('runHook: the server\'s per-agent rate limit (final fix I4)', () => {
  it('a 429 rate_limited answer is transient: activity and session-end are queued, then flushed once the limit lifts', async () => {
    const s = setup(okFetch({}));
    await runHook('claude', 'session-start', fxText('claude/session-start.json'), { env: s.env, fetchImpl: okFetch({ '/session/start': { context: 'C' } }), git: s.git });
    const limited = (async (url: string, init: any) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
      return new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'Too many requests for this agent token; retry in a minute.' } }), { status: 429 });
    }) as unknown as typeof fetch;
    const edit = fxText('claude/tool-edit.json').replace(/C:\\\\Users\\\\me\\\\repo/g, s.root.replace(/\\/g, '\\\\'));
    await runHook('claude', 'tool', edit, { env: s.env, fetchImpl: limited, git: s.git });
    await runHook('claude', 'session-end', fxText('claude/session-end.json'), { env: s.env, fetchImpl: limited, git: s.git });
    const outbox = join(s.dir, 'outbox');
    const queued = () => readdirSync(outbox).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(outbox, f), 'utf8')).path);
    expect(queued()).toEqual(['/api/hooks/activity', '/api/hooks/session/end']);
    const from = calls.length;
    await runHook('codex', 'session-start', fxText('codex/session-start.json'), { env: s.env, fetchImpl: okFetch({ '/session/start': { context: 'C' } }), git: s.git });
    expect(calls.slice(from).map((c) => c.url.replace('http://conus.test', ''))).toEqual(['/api/hooks/activity', '/api/hooks/session/end', '/api/hooks/session/start']);
    expect(queued()).toEqual([]);
  });
});

describe('runHook: commits of this repo that this session made (final fix I3, N1 rounds 2–3, N3)', () => {
  const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), D = 'd'.repeat(40);
  const start = (s: ReturnType<typeof setup>, agent: 'claude' | 'codex' = 'claude') =>
    runHook(agent, 'session-start', fxText(`${agent}/session-start.json`), { env: s.env, fetchImpl: okFetch({ '/session/start': { context: 'C' } }), git: s.git });
  // Claude Code transcript lines as recorded: prompts and tool results carry their prompt's promptId; tool_use and
  // tool_result entries carry timestamps; a result whose output named the commit carries toolUseResult.gitOperation.
  const iso = (ms: number) => new Date(ms).toISOString();
  const prompt = (content: unknown, promptId: string, extra: Record<string, unknown> = {}) =>
    ({ type: 'user', isSidechain: false, promptId, timestamp: iso(Date.now() - 5000), ...extra, message: { role: 'user', content } });
  let n = 0;
  /** One shell call of the turn: its tool_use (1 s ago) and tool_result (now). */
  const shell = (command: string, promptId: string, commit?: { sha: string; kind?: string; branch?: string }, at = Date.now()) => {
    const id = `t${++n}`;
    return [
      { type: 'assistant', isSidechain: false, timestamp: iso(at - 1000), message: { model: 'claude-opus-5', role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command, description: 'x' } }] } },
      {
        type: 'user', isSidechain: false, promptId, timestamp: iso(at),
        toolUseResult: { stdout: commit ? '[main] x' : '', stderr: '', interrupted: false, ...(commit ? { gitOperation: { commit: { kind: 'committed', branch: 'main', ...commit } } } : {}) },
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
      },
    ];
  };
  const said = { type: 'assistant', isSidechain: false, message: { model: 'claude-opus-5', role: 'assistant', content: [{ type: 'text', text: 'Готово.' }] } };
  const transcriptOf = (s: ReturnType<typeof setup>, lines: unknown[]) => {
    const p = join(s.dir, `transcript-${Math.random()}.jsonl`);
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return p;
  };
  const stopIn = (path: string, promptId: string | null) => {
    const payload = JSON.parse(fxText('claude/stop.json').replace('__TRANSCRIPT__', ''));
    return JSON.stringify({ ...payload, transcript_path: path, ...(promptId ? { prompt_id: promptId } : { prompt_id: undefined }) });
  };
  const stop = (s: ReturnType<typeof setup>, lines: unknown[], opts: { promptId?: string | null; f?: typeof fetch; git?: NonNullable<Parameters<typeof runHook>[3]>['git'] } = {}) =>
    runHook('claude', 'stop', stopIn(transcriptOf(s, lines), opts.promptId === undefined ? 'p2' : opts.promptId), {
      env: s.env, fetchImpl: opts.f ?? okFetch({ '/turn/stop': { action: 'ok' } }), git: opts.git ?? s.git,
    });
  const lastStop = () => calls.filter((c) => c.url.endsWith('/turn/stop')).at(-1)!.body;
  const tool = (s: ReturnType<typeof setup>, command: string, gitOperation?: unknown, durationMs: number | null = 1500) => {
    const payload = {
      session_id: 'cc-123', cwd: 'C:\\Users\\me\\repo', prompt_id: 'p2', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command, description: 'x' },
      tool_response: { stdout: '', stderr: '', interrupted: false, isImage: false, ...(gitOperation ? { gitOperation } : {}) },
      tool_use_id: 't-x', ...(durationMs === null ? {} : { duration_ms: durationMs }),
    };
    const from = calls.length;
    return runHook('claude', 'tool', JSON.stringify(payload), { env: s.env, fetchImpl: okFetch({}), git: s.git })
      .then(() => calls.slice(from).filter((c) => c.url.endsWith('/activity')).map((c) => c.body.facts));
  };
  /** Turn 1 (p1) explains, turn 2 (p2) commits B itself; Claude Code recorded it (gitOperation). */
  const own = () => [prompt('объясни парсер', 'p1'), ...shell('cat src/parser.ts', 'p1'), said, prompt('закоммить', 'p2'), ...shell('git add -A && git commit -m "feat: x"', 'p2', { sha: 'bbbbbbb' }), said];

  it('(i) an own commit of this turn whose async PostToolUse has not arrived → git_commit (full sha, subject from git, branch from gitOperation)', async () => {
    const s = setup(okFetch({}));
    await start(s);
    s.setHead(B, 'commit: feat: x', A);
    await stop(s, own());
    expect(lastStop().facts).toEqual([{ kind: 'git_commit', data: { sha: B, subject: 'feat: x', branch: 'main' } }]);
    // the next turn has no commit of its own: nothing
    await stop(s, [...own(), prompt('спасибо', 'p3'), ...shell('git status', 'p3'), said], { promptId: 'p3' });
    expect(lastStop().facts).toBeUndefined();
  });

  it('(ii) a quiet commit (`git commit -q`: Claude Code records nothing) → its reflog entry inside the call window is reported', async () => {
    const s = setup(okFetch({}));
    await start(s);
    s.setHead(B, 'commit: docs: quiet', A, 'docs: quiet');
    await stop(s, [prompt('закоммить тихо', 'p2'), ...shell('git add -A && git commit -q -m "docs: quiet"', 'p2'), said]);
    expect(lastStop().facts).toEqual([{ kind: 'git_commit', data: { sha: B, subject: 'docs: quiet' } }]);
    // PostToolUse: the same, from the payload's duration_ms
    expect(await tool(s, 'git add -A && git commit -q -m "docs: quiet"')).toEqual([[{ kind: 'git_commit', data: { sha: B, subject: 'docs: quiet' } }]]);
    // two quiet commits in one call → both
    s.setHead(C, 'commit: docs: second', B, 'docs: second');
    expect(await tool(s, 'git commit -q -m a && git commit -q -m b')).toEqual([[
      { kind: 'git_commit', data: { sha: B, subject: 'docs: quiet' } }, { kind: 'git_commit', data: { sha: C, subject: 'docs: second' } },
    ]]);
  });

  it('a commit in ANOTHER repo (git -C other, a scratch repo) → nothing, on Stop and on PostToolUse', async () => {
    const s = setup(okFetch({}));
    await start(s);
    await stop(s, [prompt('закоммить в другом репо', 'p2'), ...shell('git -C ../other commit --allow-empty -m "other"', 'p2', { sha: '3ee1187' }), said]);
    expect(lastStop().facts).toBeUndefined();
    expect(await tool(s, 'git -C ../other commit --allow-empty -m "other"', { commit: { sha: '3ee1187', kind: 'committed', branch: 'main' } })).toEqual([]);
  });

  it('repro 1: B stops after A committed (or the user did) earlier → no fact; B\'s `git commit` that creates nothing → still none', async () => {
    const s = setup(okFetch({}));
    await start(s);
    s.setHead(B, 'commit: feat: from A', A, 'feat: from A', Date.now() - 60_000); // a minute before B's calls
    await stop(s, [prompt('объясни', 'p1'), ...shell('cat x', 'p1'), said], { promptId: 'p1' });
    expect(lastStop().facts).toBeUndefined();
    await stop(s, [prompt('закоммить', 'p2'), ...shell('git add -A && git commit -m "feat: b"', 'p2'), said]);
    expect(lastStop().facts).toBeUndefined();
    // repro 3, PostToolUse: `git commit -m x; git status` with nothing to commit
    expect(await tool(s, 'git commit -m x; git status')).toEqual([]);
  });

  it('repro 2: an image-only prompt starts a new turn: the commit of the turn before is not reported again', async () => {
    const s = setup(okFetch({}));
    await start(s);
    s.setHead(B, 'commit: feat: from B', A);
    await stop(s, own());
    expect(lastStop().facts).toHaveLength(1);
    s.setHead(C, 'commit: feat: from A', B, 'feat: from A', Date.now() - 60_000);
    const img = prompt([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }], 'p3');
    await stop(s, [...own(), img, ...shell('cat y', 'p3'), said], { promptId: 'p3' });
    expect(lastStop().facts).toBeUndefined();
    const strip = (o: any) => { const { promptId: _drop, ...rest } = o; return rest; };
    await stop(s, [...own(), img, ...shell('cat y', 'p3'), said].map(strip), { promptId: null });
    expect(lastStop().facts).toBeUndefined();
  });

  it('a Stop-hook feedback continuation (as recorded: isMeta, same promptId) is the same turn: its commits are sent again, the server keeps one', async () => {
    const s = setup(okFetch({}));
    await start(s);
    s.setHead(B, 'commit: feat: x', A);
    const feedback = prompt('Stop hook feedback:\n…', 'p2', { isMeta: true });
    await stop(s, [...own(), feedback, ...shell('git status', 'p2'), said]);
    expect(lastStop().facts).toEqual([{ kind: 'git_commit', data: { sha: B, subject: 'feat: x', branch: 'main' } }]);
    s.setHead(C, 'commit: feat: y', B, 'feat: y');
    await stop(s, [...own(), feedback, ...shell('git commit -am y', 'p2', { sha: 'ccccccc' }), said]);
    expect(lastStop().facts).toEqual([
      { kind: 'git_commit', data: { sha: B, subject: 'feat: x', branch: 'main' } }, { kind: 'git_commit', data: { sha: C, subject: 'feat: y', branch: 'main' } },
    ]);
  });

  it('a compact summary inside the turn does not hide the commit after it', async () => {
    const s = setup(okFetch({}));
    await start(s);
    s.setHead(B, 'commit: feat: x', A);
    const compact = { type: 'user', isSidechain: false, isCompactSummary: true, isVisibleInTranscriptOnly: true, promptId: 'p9', message: { role: 'user', content: 'This session is being continued…' } };
    await stop(s, [prompt('сделай и закоммить', 'p2'), ...shell('npm test', 'p2'), compact, ...shell('git commit -am x', 'p2', { sha: 'bbbbbbb' }), said]);
    expect(lastStop().facts).toEqual([{ kind: 'git_commit', data: { sha: B, subject: 'feat: x', branch: 'main' } }]);
  });

  it('several recorded commits in a turn → each once, in order; one git cannot resolve in this repo → dropped', async () => {
    const s = setup(okFetch({}));
    await start(s);
    s.setHead(B, 'commit: feat: x', A, 'feat: x', Date.now() - 60_000);
    s.setHead(C, 'commit: feat: y', B, 'feat: y', Date.now() - 50_000);
    await stop(s, [prompt('коммиты', 'p2'), ...shell('npm run release', 'p2', { sha: 'bbbbbbb' }), ...shell('npm run release', 'p2', { sha: 'ccccccc' }), ...shell('npm run release', 'p2', { sha: '1234abc' }), ...shell('npm run release', 'p2', { sha: 'bbbbbbb' }), said]);
    expect(lastStop().facts).toEqual([
      { kind: 'git_commit', data: { sha: B, subject: 'feat: x', branch: 'main' } }, { kind: 'git_commit', data: { sha: C, subject: 'feat: y', branch: 'main' } },
    ]);
  });

  it('an amend: amends = HEAD@{1} only while the reflog top is that commit\'s `commit (amend)`', async () => {
    const s = setup(okFetch({}));
    await start(s);
    s.setHead(C, 'commit (amend): feat: x', B);
    const amend = [prompt('поправь сообщение', 'p2'), ...shell('git commit --amend -m "feat: x"', 'p2', { sha: 'ccccccc', kind: 'amended', branch: undefined as unknown as string }), said];
    await stop(s, amend);
    expect(lastStop().facts).toEqual([{ kind: 'git_commit', data: { sha: C, subject: 'feat: x', amends: B } }]);
    s.setHead(D, 'commit: other', C, 'other', Date.now() + 60_000); // another commit on top, after the call
    await stop(s, amend);
    expect(lastStop().facts).toEqual([{ kind: 'git_commit', data: { sha: C, subject: 'feat: x' } }]);
  });

  it('no transcript, an unreadable one, or Codex → no Stop fact', async () => {
    const s = setup(okFetch({}));
    await start(s);
    s.setHead(B, 'commit: feat: x', A);
    await runHook('claude', 'stop', fxText('claude/stop.json').replace('__TRANSCRIPT__', ''), { env: s.env, fetchImpl: okFetch({ '/turn/stop': { action: 'ok' } }), git: s.git });
    expect(lastStop().facts).toBeUndefined();
    await runHook('claude', 'stop', stopIn(join(s.dir, 'missing.jsonl'), 'p2'), { env: s.env, fetchImpl: okFetch({ '/turn/stop': { action: 'ok' } }), git: s.git });
    expect(lastStop().facts).toBeUndefined();
    const c = setup(okFetch({}));
    await start(c, 'codex');
    c.setHead(B, 'commit: feat: x', A);
    const codexStop = JSON.stringify({ ...JSON.parse(fxText('codex/stop.json')), transcript_path: transcriptOf(c, own()) });
    await runHook('codex', 'stop', codexStop, { env: c.env, fetchImpl: okFetch({ '/turn/stop': { action: 'ok' } }), git: c.git });
    expect(lastStop().facts).toBeUndefined();
  });

  it('the saved HEAD absorbs every HEAD a Stop observes: Codex then never reports another session\'s commit as its own', async () => {
    const s = setup(okFetch({}));
    await start(s, 'codex');
    s.setHead(B, 'commit: feat: from A', A, 'feat: from A'); // A commits in the shared worktree
    await runHook('codex', 'stop', fxText('codex/stop.json'), { env: s.env, fetchImpl: okFetch({ '/turn/stop': { action: 'ok' } }), git: s.git });
    expect(s.savedHead()).toBe(B);
    const from = calls.length;
    const noop = JSON.stringify({ session_id: '019a0000-aaaa', cwd: 'C:\\Users\\me\\repo', hook_event_name: 'PostToolUse', turn_id: 'turn-2', tool_name: 'shell', tool_input: { command: ['bash', '-lc', 'git commit -am x'] }, tool_response: 'Exit code: 0\nOutput:\nnothing to commit' });
    await runHook('codex', 'tool', noop, { env: s.env, fetchImpl: okFetch({}), git: s.git });
    expect(calls.slice(from).filter((c) => c.url.endsWith('/activity'))).toEqual([]);
    // Claude too: a Stop records the HEAD it saw, and its own evidence never depends on it
    const t = setup(okFetch({}));
    await start(t);
    t.setHead(B, 'commit: feat: x', A);
    await stop(t, own());
    expect(t.savedHead()).toBe(B);
    await stop(t, own());
    expect(lastStop().facts).toHaveLength(1);
  });

  it('PowerShell: the recorded transcript gives the commit from its gitOperation', async () => {
    const s = setup(okFetch({}));
    await start(s);
    const full = '1cbc0fc' + '0'.repeat(33);
    s.setHead(full, 'commit: docs: add notes', A, 'docs: add notes', Date.parse('2026-10-09T01:28:09.000Z'));
    const recorded = fxText('claude/transcript-powershell.jsonl').trim().split('\n').map((l) => JSON.parse(l));
    await stop(s, recorded, { promptId: 'p-1' });
    expect(lastStop().facts).toEqual([{ kind: 'git_commit', data: { sha: full, subject: 'docs: add notes', branch: 'main' } }]);
    // the same turn without the commit call: nothing
    await stop(s, [recorded[0], recorded[3], recorded[4], recorded[5]], { promptId: 'p-1' });
    expect(lastStop().facts).toBeUndefined();
  });

  it('PowerShell: the recorded PostToolUse payload posts the commit from its gitOperation', async () => {
    const s = setup(okFetch({}));
    await start(s);
    const full = '1cbc0fc' + '0'.repeat(33);
    s.setHead(full, 'commit: docs: add notes', A, 'docs: add notes');
    const from = calls.length;
    await runHook('claude', 'tool', fxText('claude/tool-powershell-commit.json'), { env: s.env, fetchImpl: okFetch({}), git: s.git });
    expect(calls.slice(from).filter((c) => c.url.endsWith('/activity')).map((c) => c.body.facts))
      .toEqual([[{ kind: 'git_commit', data: { sha: full, subject: 'docs: add notes', branch: 'main' } }]]);
  });

  it('more than 10 commits in a turn (25 in one call) → the newest 10 go with the stop, HEAD among them', async () => {
    const s = setup(okFetch({}));
    await start(s);
    const shas = Array.from({ length: 25 }, (_, i) => (i + 1).toString(16).padStart(2, '0').repeat(20));
    const t = Date.now() - 500;
    shas.forEach((h, i) => s.setHead(h, `commit: c${i + 1}`, null, `c${i + 1}`, t + i));
    await stop(s, [prompt('25 коммитов', 'p2'), ...shell('for i in $(seq 25); do git commit -q --allow-empty -m c$i; done', 'p2'), said]);
    const facts = lastStop().facts as { data: { sha: string; subject: string } }[];
    expect(facts.map((f) => f.data.subject)).toEqual(Array.from({ length: 10 }, (_, i) => `c${i + 16}`));
    expect(facts.at(-1)!.data.sha).toBe(shas[24]); // HEAD
  });

  it('N3: flush and git share their own 1 s; the turn/stop request keeps its full 5 s', async () => {
    const s = setup(okFetch({}));
    await start(s);
    // a queued event and a server that hangs on it: the flush may take only its share
    await runHook('claude', 'tool', fxText('claude/tool-edit.json').replace(/C:\\\\Users\\\\me\\\\repo/g, s.root.replace(/\\/g, '\\\\')), { env: s.env, fetchImpl: downFetch, git: s.git });
    s.setHead(B, 'commit: feat: x', A);
    const gitTimeouts: number[] = [];
    const git = {
      ...s.git,
      reflog: (cwd: string, t?: number) => { gitTimeouts.push(t!); return s.git.reflog(); },
      resolveCommit: (cwd: string, sha: string, t?: number) => { gitTimeouts.push(t!); return s.git.resolveCommit(cwd, sha); },
    };
    const timeouts = vi.spyOn(AbortSignal, 'timeout');
    const t0 = Date.now();
    const hangOnActivity = (async (url: string, init: any) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (url.endsWith('/activity')) return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
      return new Response(JSON.stringify({ action: 'ok' }), { status: 200 });
    }) as unknown as typeof fetch;
    let ms: number[];
    try {
      await stop(s, own(), { f: hangOnActivity, git });
      ms = timeouts.mock.calls.map((c) => c[0] as number);
    } finally {
      timeouts.mockRestore();
    }
    expect(ms.at(-1)).toBe(HOOK_BUDGET_MS.stop); // the turn/stop request
    expect(ms.slice(0, -1).every((m) => m <= STOP_PREWORK_MS / 2)).toBe(true); // the flush
    // the one reflog read gets what the flush left of the 1 s (the hanging flush used its half)
    expect(gitTimeouts).toHaveLength(1);
    expect(gitTimeouts[0]).toBeLessThanOrEqual(STOP_PREWORK_MS / 2 + 50);
    expect(lastStop().facts).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(STOP_PREWORK_MS + 1500);
  });
});

describe('runHook: commits are checked in the session repo root, never in the shell\'s cwd (N1 round 4, real git)', () => {
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (cwd: string, args: string[], extra: Record<string, string> = {}) =>
    execFileSync('git', args, { cwd, env: { ...gitEnv, ...extra }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  // The repo's first commit an hour ago: never inside a call window (the reflog records the committer date).
  const hourAgo = () => { const d = new Date(Date.now() - 3_600_000).toISOString(); return { GIT_COMMITTER_DATE: d, GIT_AUTHOR_DATE: d }; };
  const f = okFetch({ '/session/start': { context: 'C' }, '/turn/stop': { action: 'ok' } });
  const said = { type: 'assistant', isSidechain: false, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };

  /** A session repo with a subdirectory, a transcript, and a helper that runs one shell call as Claude Code reports it. */
  async function session(agent: 'claude' | 'codex') {
    const base = mkdtempSync(join(tmpdir(), 'conus-nested-'));
    const repo = join(base, 'repo');
    mkdirSync(join(repo, 'sub'), { recursive: true });
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'init'], hourAgo());
    const env = { CONUS_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'conus-nested-cfg-')) };
    writeConfig({ url: 'http://conus.test', token: 'tm_t', sendText: false }, env);
    const transcript = join(base, 't.jsonl');
    writeFileSync(transcript, JSON.stringify({ type: 'user', isSidechain: false, promptId: 'p1', timestamp: new Date().toISOString(), message: { role: 'user', content: 'go' } }) + '\n');
    const sid = `${agent}-nested`;
    await runHook(agent, 'session-start', JSON.stringify({ session_id: sid, cwd: repo, transcript_path: transcript, source: 'startup' }), { env, fetchImpl: f });
    let n = 0;
    /** `work` runs the git commands; `hookCwd` is the directory Claude Code / Codex reports afterwards. */
    const call = async (command: string, hookCwd: string, work: () => string) => {
      const id = `t${++n}`;
      const t0 = Date.now();
      appendFileSync(transcript, JSON.stringify({ type: 'assistant', isSidechain: false, timestamp: new Date(t0).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } }) + '\n');
      const out = work();
      const m = /^\[(\S+)(?: \([^)]*\))? ([0-9a-f]{7,})\]/m.exec(out); // how Claude Code builds gitOperation
      const resp = { stdout: out, stderr: '', interrupted: false, ...(m ? { gitOperation: { commit: { sha: m[2]!.slice(0, 7), kind: 'committed', branch: m[1] } } } : {}) };
      const from = calls.length;
      const payload = agent === 'claude'
        ? { session_id: sid, cwd: hookCwd, transcript_path: transcript, prompt_id: 'p1', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: resp, tool_use_id: id, duration_ms: Date.now() - t0 }
        : { session_id: sid, cwd: hookCwd, hook_event_name: 'PostToolUse', turn_id: 'turn-1', tool_name: 'shell', tool_input: { command: ['bash', '-lc', command] }, tool_response: `Exit code: 0\nOutput:\n${out}` };
      await runHook(agent, 'tool', JSON.stringify(payload), { env, fetchImpl: f });
      appendFileSync(transcript, JSON.stringify({ type: 'user', isSidechain: false, promptId: 'p1', timestamp: new Date().toISOString(), toolUseResult: resp, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x' }] } }) + '\n');
      return calls.slice(from).filter((c) => c.url.endsWith('/activity')).flatMap((c) => c.body.facts).filter((x: any) => x.kind === 'git_commit').map((x: any) => x.data.subject);
    };
    const stop = async (hookCwd: string) => {
      appendFileSync(transcript, JSON.stringify(said) + '\n');
      await runHook(agent, 'stop', JSON.stringify({ session_id: sid, cwd: hookCwd, transcript_path: transcript, prompt_id: 'p1', hook_event_name: 'Stop', stop_hook_active: false }), { env, fetchImpl: f });
      return (calls.filter((c) => c.url.endsWith('/turn/stop')).at(-1)!.body.facts ?? []).map((x: any) => x.data.subject);
    };
    return { repo, sub: join(repo, 'sub'), scratch: join(repo, 'scratch'), call, stop };
  }

  it('every commit-detection git call (reflog, resolve, HEAD) goes to the session root, whatever the hook cwd; Codex never resolves', async () => {
    for (const agent of ['claude', 'codex'] as const) {
      const s = setup(okFetch({}));
      const seen: string[] = [];
      const git = {
        ...s.git,
        headCommit: (cwd: string) => { seen.push(`head ${cwd}`); return s.git.headCommit(); },
        reflog: (cwd: string) => { seen.push(`reflog ${cwd}`); return s.git.reflog(); },
        resolveCommit: (cwd: string, sha: string) => { seen.push(`resolve ${cwd}`); return s.git.resolveCommit(cwd, sha); },
      };
      await runHook(agent, 'session-start', fxText(`${agent}/session-start.json`), { env: s.env, fetchImpl: okFetch({ '/session/start': { context: 'C' } }), git });
      s.setHead('b'.repeat(40), 'commit: feat: x', 'a'.repeat(40));
      const nested = 'C:\\Users\\me\\repo\\scratch';
      const payload = agent === 'claude'
        ? { session_id: 'cc-123', cwd: nested, prompt_id: 'p-1', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, tool_response: { stdout: '[main bbbbbbb] x', gitOperation: { commit: { sha: 'bbbbbbb', kind: 'committed', branch: 'main' } } }, duration_ms: 500 }
        : { session_id: '019a0000-aaaa', cwd: nested, hook_event_name: 'PostToolUse', turn_id: 'turn-1', tool_name: 'shell', tool_input: { command: ['bash', '-lc', 'git commit -m x'] }, tool_response: 'Exit code: 0\nOutput:\nok' };
      await runHook(agent, 'tool', JSON.stringify(payload), { env: s.env, fetchImpl: okFetch({}), git });
      if (agent === 'claude') {
        const transcript = join(s.dir, 't.jsonl');
        writeFileSync(transcript, [
          { type: 'user', isSidechain: false, promptId: 'p-1', timestamp: new Date(Date.now() - 2000).toISOString(), message: { role: 'user', content: 'go' } },
          { type: 'assistant', isSidechain: false, timestamp: new Date(Date.now() - 1000).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git commit -m x' } }] } },
          { type: 'user', isSidechain: false, promptId: 'p-1', timestamp: new Date().toISOString(), toolUseResult: payload.tool_response, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } },
        ].map((l) => JSON.stringify(l)).join('\n') + '\n');
        await runHook('claude', 'stop', JSON.stringify({ session_id: 'cc-123', cwd: nested, transcript_path: transcript, prompt_id: 'p-1', hook_event_name: 'Stop', stop_hook_active: false }), { env: s.env, fetchImpl: okFetch({ '/turn/stop': { action: 'ok' } }), git });
      }
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.filter((x) => !x.endsWith(` ${s.root}`))).toEqual([]);
      if (agent === 'codex') expect(seen.filter((x) => x.startsWith('resolve'))).toEqual([]);
    }
  });

  it('Claude: after `cd` into a nested repo, its commits are no fact on PostToolUse or Stop; a subdirectory of the same repo still reports', async () => {
    const s = await session('claude');
    // a quiet commit in a nested repo the shell `cd`ed into: Claude Code then reports that directory as the hook cwd
    expect(await s.call('mkdir scratch && cd scratch && git init -q && git commit -q --allow-empty -m "scratch quiet"', s.scratch, () => {
      mkdirSync(s.scratch);
      git(s.scratch, ['init', '-q', '-b', 'main']);
      return git(s.scratch, ['commit', '-q', '--allow-empty', '-m', 'scratch quiet']);
    })).toEqual([]);
    // a normal commit there: Claude Code's record names the nested repo's sha
    expect(await s.call('git commit --allow-empty -m "scratch normal"', s.scratch, () => git(s.scratch, ['commit', '--allow-empty', '-m', 'scratch normal']))).toEqual([]);
    expect(await s.stop(s.scratch)).toEqual([]);
    // from a subdirectory of the session's own repo: reported, quiet or not
    expect(await s.call('cd ../sub && git commit -q --allow-empty -m "from sub"', s.sub, () => git(s.sub, ['commit', '-q', '--allow-empty', '-m', 'from sub']))).toEqual(['from sub']);
    // (the quiet commit a moment ago lies inside this call's window too: the same session's, the server keeps it once)
    const loud = await s.call('git commit --allow-empty -m "from sub, loud"', s.sub, () => git(s.sub, ['commit', '--allow-empty', '-m', 'from sub, loud']));
    expect(loud).toContain('from sub, loud');
    expect(loud.every((x) => x.startsWith('from sub'))).toBe(true);
    expect(await s.stop(s.sub)).toEqual(['from sub', 'from sub, loud']);
  }, 30_000);

  it('Codex: HEAD is read in the session repo root: a commit in a nested repo after `cd` is no fact; one from a subdirectory is', async () => {
    const s = await session('codex');
    expect(await s.call('mkdir scratch && cd scratch && git init -q && git commit -q --allow-empty -m "scratch"', s.scratch, () => {
      mkdirSync(s.scratch);
      git(s.scratch, ['init', '-q', '-b', 'main']);
      return git(s.scratch, ['commit', '-q', '--allow-empty', '-m', 'scratch']);
    })).toEqual([]);
    expect(await s.call('cd ../sub && git commit -q --allow-empty -m "from sub"', s.sub, () => git(s.sub, ['commit', '-q', '--allow-empty', '-m', 'from sub']))).toEqual(['from sub']);
  }, 30_000);
});

describe('runHook: raw payload recording (CONUS_HOOK_RECORD_DIR)', () => {
  it('writes one file per call with the raw stdin, named after agent and event', async () => {
    const s = setup(okFetch({}));
    const rec = join(mkdtempSync(join(tmpdir(), 'conus-rec-')), 'nested', 'records');
    const env = { ...s.env, CONUS_HOOK_RECORD_DIR: rec };
    const f = okFetch({ '/session/start': { context: 'C' } });
    const startIn = fxText('claude/session-start.json');
    await runHook('claude', 'session-start', startIn, { env, fetchImpl: f, git: s.git });
    await runHook('claude', 'prompt', fxText('claude/prompt.json'), { env, fetchImpl: f, git: s.git });
    await runHook('claude', 'prompt', fxText('claude/prompt.json'), { env, fetchImpl: f, git: s.git });
    await runHook('claude', 'stop', 'not json', { env, fetchImpl: f, git: s.git });
    const files = readdirSync(rec).sort();
    expect(files).toHaveLength(4);
    expect(files.filter((n) => n.startsWith('claude-prompt-'))).toHaveLength(2);
    const startFile = files.find((n) => n.startsWith('claude-session-start-'))!;
    expect(readFileSync(join(rec, startFile), 'utf8')).toBe(startIn);
    expect(readFileSync(join(rec, files.find((n) => n.startsWith('claude-stop-'))!), 'utf8')).toBe('not json');
  });

  it('records nothing without the variable, and an unwritable record dir never breaks the hook', async () => {
    const s = setup(okFetch({}));
    const f = okFetch({ '/session/start': { context: 'C' } });
    expect(await runHook('claude', 'session-start', fxText('claude/session-start.json'), { env: s.env, fetchImpl: f, git: s.git })).toBe('C');
    expect(readdirSync(s.dir).some((n) => n.includes('record'))).toBe(false);
    const blocker = join(s.dir, 'blocker');
    writeFileSync(blocker, 'x');
    const env = { ...s.env, CONUS_HOOK_RECORD_DIR: join(blocker, 'sub') };
    expect(await runHook('claude', 'session-start', fxText('claude/session-start.json'), { env, fetchImpl: f, git: s.git })).toBe('C');
  });
});

describe('per-repo disable (.conus.json)', () => {
  it('writes .conus.json once into .git/info/exclude, enabling removes it', () => {
    const root = mkdtempSync(join(tmpdir(), 'conus-dis-'));
    mkdirSync(join(root, '.git'));
    expect(isRepoDisabled(root)).toBe(false);
    setRepoEnabled(root, false);
    setRepoEnabled(root, false);
    expect(isRepoDisabled(root)).toBe(true);
    expect(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8').split('\n').filter((l) => l === '.conus.json')).toHaveLength(1);
    setRepoEnabled(root, true);
    expect(existsSync(join(root, '.conus.json'))).toBe(false);
    expect(isRepoDisabled(root)).toBe(false);
  });
});
