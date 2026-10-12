import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS_MD_END, AGENTS_MD_START, GLOBAL_RULES_BLOCK } from '@conus/protocol';
import { runCli, VERSION, type CliIO } from '../src/cli';
import { installStdoutGuard } from '../src/stdout-guard';

const WHOAMI_OK = { '/api/hooks/whoami': { status: 200, body: { agent: { name: 'claude-code@pc', kind: 'claude_code' } } } };
const HEALTHY = {
  '/healthz': { status: 200, body: { ok: true } },
  ...WHOAMI_OK,
  '/api/hooks/session/start': { status: 200, body: { enabled: true, session_ref: 'S-1', project_key: 'REP', context: 'CTX-1' } },
  '/api/hooks/session/end': { status: 204 },
};

type RunResult = { code: number; stdout: string; stderr: string };
function io(overrides: Partial<CliIO> & {
  fetchMap?: Record<string, { status: number; body?: unknown }>;
  /** What each spawned program answers (default: exit 0); `claude --version` failing means no claude CLI. */
  runs?: (cmd: string, args: string[]) => RunResult;
  answers?: (string | null)[];
} = {}) {
  const { fetchMap, runs, answers = [], ...rest } = overrides;
  const out: string[] = []; const err: string[] = []; const execs: string[][] = []; const asked: string[] = [];
  const requests: { url: string; method: string; body: any }[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'conus-cli-'));
  const home = mkdtempSync(join(tmpdir(), 'conus-home-'));
  const fetchImpl = (async (url: string, init: any) => {
    requests.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null });
    const key = Object.keys(fetchMap ?? {}).find((k) => url.endsWith(k));
    const r = key ? fetchMap![key]! : { status: 404 };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  const base: CliIO = {
    stdout: (s) => out.push(s), stderr: (s) => err.push(s), readStdin: async () => '{}',
    env: { CONUS_CONFIG_DIR: dir, CONUS_HOME_OVERRIDE: home, CONUS_LANG: 'en', PATH: binDir() }, cwd: dir, platform: 'linux', fetchImpl,
    run: (c, a) => { execs.push([c, ...a]); return runs ? runs(c, a) : { code: 0, stdout: '', stderr: '' }; },
    ask: async (q) => { asked.push(q); return answers.length ? answers.shift()! : null; },
  };
  return { io: { ...base, ...rest }, out, err, execs, asked, requests, dir, home };
}

/** A PATH directory with a `conus` in it, as after `npm install -g conus-cli`. */
function binDir(withConus = true): string {
  const d = mkdtempSync(join(tmpdir(), 'conus-bin-'));
  if (withConus) writeFileSync(join(d, 'conus'), '#!/bin/sh\n', { mode: 0o755 });
  return d;
}

/** A fresh git repo (no commits needed); the path is the canonical one git reports. */
function gitRepo(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'conus-cli-repo-')));
  execFileSync('git', ['init', '-q', root], { stdio: 'ignore' });
  return root;
}

const configPath = (dir: string) => join(dir, 'config.json');

describe('conus CLI', () => {
  it('login verifies the token and saves the config, touching no environment variables on any platform', async () => {
    for (const platform of ['win32', 'linux'] as const) {
      const t = io({ platform, fetchMap: WHOAMI_OK });
      expect(await runCli(['login', 'https://conus.example.com/', 'conus_abc'], t.io)).toBe(0);
      expect(JSON.parse(readFileSync(join(t.dir, 'config.json'), 'utf8'))).toMatchObject({ url: 'https://conus.example.com', token: 'conus_abc' });
      expect(t.execs).toEqual([]);
      expect(t.out.join('\n')).toBe('Logged in as claude-code@pc.');
    }
  });

  it('speaks Russian when the locale is Russian', async () => {
    const t = io({ fetchMap: WHOAMI_OK });
    expect(await runCli(['login', 'https://conus.example.com', 'conus_abc'], { ...t.io, env: { ...t.io.env, CONUS_LANG: '', LANG: 'ru_RU.UTF-8' } })).toBe(0);
    expect(t.out.join('\n')).toBe('Вход выполнен: агент claude-code@pc.');
  });

  it('login fails on a bad token without writing config', async () => {
    const t = io({ fetchMap: { '/api/hooks/whoami': { status: 401, body: { error: { code: 'unauthorized' } } } } });
    expect(await runCli(['login', 'https://conus.example.com', 'conus_bad'], t.io)).toBe(1);
    expect(() => readFileSync(join(t.dir, 'config.json'))).toThrow();
  });

  it.each([
    ['a single quote', "conus_a'b"],
    ['a double quote', 'conus_a"b'],
    ['a backtick', 'conus_a`b'],
    ['a space', 'conus_a b'],
    ['a newline', 'conus_a\nb'],
    ['a NUL character', 'conus_a\u0000b'],
  ])('login rejects a token with %s before any network call or write', async (_name, token) => {
    const t = io({ platform: 'win32', fetchMap: WHOAMI_OK });
    expect(await runCli(['login', 'https://conus.example.com', token], t.io)).toBe(1);
    expect(t.err.join('\n')).toMatch(/token/i);
    expect(t.requests).toEqual([]);
    expect(t.execs).toEqual([]);
    expect(existsSync(configPath(t.dir))).toBe(false);
    expect(t.out).toEqual([]);
  });

  it('login with a missing argument prints usage and exits 1', async () => {
    const t = io({ fetchMap: WHOAMI_OK });
    expect(await runCli(['login', 'https://conus.example.com'], t.io)).toBe(1);
    expect(t.err.join('\n')).toContain('usage: conus login');
    expect(t.requests).toEqual([]);
  });

  it.each([
    ['a non-http scheme', 'ftp://conus.example.com'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a bare host without a scheme', 'conus.example.com'],
    ['a host:port without a scheme', 'localhost:3000'],
    ['whitespace', 'https://conus.example.com/ x'],
    ['a leading space', ' https://conus.example.com'],
    ['a tab', 'https://conus.example.com/\tx'],
    ['a newline', 'https://conus.example.com\nsetx'],
    ['a double quote', 'https://conus.example.com/"'],
    ['a single quote', "https://conus.example.com/'"],
    ['a backtick', 'https://conus.example.com/`x`'],
    ['a NUL character', 'https://conus.example.com/\u0000'],
    ['an escape character', 'https://conus.example.com/\u001b[0m'],
    ['a DEL character', 'https://conus.example.com/\u007f'],
  ])('login rejects %s before any network call or write', async (_name, url) => {
    const t = io({ platform: 'win32', fetchMap: WHOAMI_OK });
    expect(await runCli(['login', url, 'conus_abc'], t.io)).toBe(1);
    expect(t.err.join('\n')).toMatch(/URL/);
    expect(t.requests).toEqual([]);
    expect(t.execs).toEqual([]);
    expect(existsSync(configPath(t.dir))).toBe(false);
    expect(t.out).toEqual([]);
  });

  it('login rejects a server answer without an agent name and writes nothing', async () => {
    const t = io({ platform: 'win32', fetchMap: { '/api/hooks/whoami': { status: 200, body: { ok: true } } } });
    expect(await runCli(['login', 'https://conus.example.com', 'conus_abc'], t.io)).toBe(1);
    expect(existsSync(configPath(t.dir))).toBe(false);
    expect(t.execs).toEqual([]);
  });

  it('hook always exits 0 and prints the runner output', async () => {
    const t = io({ readStdin: async () => 'garbage' });
    expect(await runCli(['hook', 'stop', '--agent', 'claude'], t.io)).toBe(0);
    expect(t.out.join('')).toBe('');
    expect(await runCli(['hook', 'nonsense', '--agent', 'claude'], t.io)).toBe(0);
  });

  it('hook exits 0 even when stdin cannot be read, and for an unknown agent', async () => {
    const t = io({ readStdin: async () => { throw new Error('stdin closed'); } });
    expect(await runCli(['hook', 'stop', '--agent', 'claude'], t.io)).toBe(0);
    expect(await runCli(['hook', 'stop', '--agent', 'cursor'], t.io)).toBe(0);
    expect(await runCli(['hook'], t.io)).toBe(0);
    expect(t.out).toEqual([]);
  });

  it('hook exits 0 even when stdout and stderr both throw', async () => {
    const repo = gitRepo();
    const t = io({ fetchMap: HEALTHY });
    await runCli(['login', 'http://conus.test', 'conus_1'], t.io);
    const broken = {
      ...t.io,
      readStdin: async () => JSON.stringify({ session_id: 'cc-2', cwd: repo, source: 'startup' }),
      stdout: () => { throw new Error('write EPIPE'); },
      stderr: () => { throw new Error('write EPIPE'); },
    };
    expect(await runCli(['hook', 'session-start', '--agent', 'claude'], broken)).toBe(0);
    // A normal command keeps its exit code when stderr is gone too.
    expect(await runCli(['bogus'], broken)).toBe(1);
  });

  it('hook prints what the runner returns (session-start context)', async () => {
    const repo = gitRepo();
    const t = io({ fetchMap: HEALTHY });
    await runCli(['login', 'http://conus.test', 'conus_1'], t.io);
    const withStdin = { ...t.io, readStdin: async () => JSON.stringify({ session_id: 'cc-1', cwd: repo, source: 'startup' }) };
    expect(await runCli(['hook', 'session-start', '--agent', 'claude'], withStdin)).toBe(0);
    expect(t.out.join('')).toContain('CTX-1');
    expect(t.requests.some((r) => r.url.endsWith('/api/hooks/session/start'))).toBe(true);
  });

  it('doctor fails when not logged in', async () => {
    const t = io();
    expect(await runCli(['doctor'], t.io)).toBe(1);
    expect(t.out.join('\n')).toMatch(/✗ config/);
  });

  it('doctor reports a healthy chain, and the roundtrip sends a repo-relative cwd only', async () => {
    const repo = gitRepo();
    const sub = join(repo, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    const t = io({ fetchMap: HEALTHY });
    await runCli(['login', 'http://conus.test', 'conus_1'], t.io);
    const env = { ...t.io.env, CONUS_URL: 'http://conus.test', CONUS_TOKEN: 'conus_1' };

    expect(await runCli(['doctor'], { ...t.io, env, cwd: sub })).toBe(0);
    const text = t.out.join('\n');
    expect(text).toMatch(/✓ config: http:\/\/conus\.test/);
    expect(text).toMatch(/✓ server/);
    expect(text).toMatch(/✓ token: agent claude-code@pc/);
    expect(text).toMatch(/✓ path/);
    expect(text).toMatch(/✓ roundtrip/);

    const start = t.requests.find((r) => r.url.endsWith('/api/hooks/session/start'))!;
    const end = t.requests.find((r) => r.url.endsWith('/api/hooks/session/end'))!;
    expect(start.body.cwd).toBe('packages/app');
    expect(start.body.agent_session_id).toMatch(/^doctor-\d+$/);
    expect(end.body).toMatchObject({ agent_session_id: start.body.agent_session_id, reason: 'doctor' });
    // No absolute path of the machine leaves it.
    const sent = JSON.stringify(t.requests.map((r) => r.body)).replace(/\\\\/g, '/').toLowerCase();
    expect(sent).not.toContain(dirname(repo).replace(/\\/g, '/').toLowerCase());
  });

  it('doctor sends cwd "." from the repo root', async () => {
    const repo = gitRepo();
    const t = io({ fetchMap: HEALTHY });
    await runCli(['login', 'http://conus.test', 'conus_1'], t.io);
    await runCli(['doctor'], { ...t.io, cwd: repo });
    expect(t.requests.find((r) => r.url.endsWith('/api/hooks/session/start'))!.body.cwd).toBe('.');
  });

  it('doctor: conus missing from PATH warns, missing server and rejected token fail, no roundtrip outside a git repo', async () => {
    const t = io({ fetchMap: { '/healthz': { status: 503 }, '/api/hooks/whoami': { status: 401 } } });
    t.io.env.PATH = binDir(false);
    await runCli(['login', 'http://conus.test', 'conus_1'], { ...t.io, fetchImpl: io({ fetchMap: WHOAMI_OK }).io.fetchImpl });
    expect(await runCli(['doctor'], t.io)).toBe(1);
    const text = t.out.join('\n');
    expect(text).toMatch(/✗ server: unreachable/);
    expect(text).toMatch(/✗ token: the server rejected the token/);
    expect(text).toMatch(/! path: conus is not on PATH/);
    expect(text).not.toMatch(/roundtrip/);
  });

  it('doctor: a failing roundtrip is a fail', async () => {
    const repo = gitRepo();
    const t = io({ fetchMap: { ...HEALTHY, '/api/hooks/session/start': { status: 500 } } });
    await runCli(['login', 'http://conus.test', 'conus_1'], t.io);
    expect(await runCli(['doctor'], { ...t.io, cwd: repo })).toBe(1);
    expect(t.out.join('\n')).toMatch(/✗ roundtrip/);
  });

  it('doctor: installed agents are checked (claude warn, codex warn until hooks are approved, then ok)', async () => {
    const t = io({ fetchMap: HEALTHY });
    await runCli(['login', 'http://conus.test', 'conus_1'], t.io);
    mkdirSync(join(t.home, '.claude'), { recursive: true });
    mkdirSync(join(t.home, '.codex'), { recursive: true });

    expect(await runCli(['doctor'], t.io)).toBe(0);
    expect(t.out.join('\n')).toMatch(/! claude: plugin not found/);
    expect(t.out.join('\n')).toMatch(/! codex: not installed/);

    expect(await runCli(['install', 'codex'], t.io)).toBe(0);
    t.out.length = 0;
    expect(await runCli(['doctor'], t.io)).toBe(0);
    expect(t.out.join('\n')).toMatch(/! codex: installed; approve the hooks/);

    const cfg = join(t.home, '.codex', 'config.toml');
    writeFileSync(cfg, readFileSync(cfg, 'utf8') + '\n[hooks.state]\ntrusted_hash = "sha256:abc"\n');
    t.out.length = 0;
    expect(await runCli(['doctor'], t.io)).toBe(0);
    expect(t.out.join('\n')).toMatch(/✓ codex/);

    writeFileSync(join(t.home, '.claude', 'settings.json'), '{"enabledPlugins":{"conus@conus":true}}');
    t.out.length = 0;
    await runCli(['doctor'], t.io);
    expect(t.out.join('\n')).toMatch(/✓ claude/);
  });

  it('config set send_text and version/help', async () => {
    const t = io({ fetchMap: { '/api/hooks/whoami': { status: 200, body: { agent: { name: 'a', kind: 'codex' } } } } });
    await runCli(['login', 'http://x', 'conus_1'], t.io);
    expect(await runCli(['config', 'set', 'send_text', 'false'], t.io)).toBe(0);
    expect(JSON.parse(readFileSync(join(t.dir, 'config.json'), 'utf8')).send_text).toBe(false);
    expect(await runCli(['--version'], t.io)).toBe(0);
    expect(await runCli(['help'], t.io)).toBe(0);
    expect(await runCli(['bogus'], t.io)).toBe(1);
  });

  it('--version prints the package version; help lists the commands', async () => {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
    expect(VERSION).toBe(pkg.version);
    const t = io();
    await runCli(['--version'], t.io);
    expect(t.out).toEqual([VERSION]);
    t.out.length = 0;
    expect(await runCli([], t.io)).toBe(0);
    expect(t.out.join('\n')).toMatch(/conus login[\s\S]*conus doctor[\s\S]*conus disable/);
  });

  it('config set: invalid input and not-logged-in give a short message and exit 1', async () => {
    const t = io({ fetchMap: WHOAMI_OK });
    expect(await runCli(['config', 'set', 'send_text', 'true'], t.io)).toBe(1);
    expect(t.err.join('\n')).toMatch(/conus login/);
    await runCli(['login', 'http://x', 'conus_1'], t.io);
    expect(await runCli(['config', 'set', 'send_text', 'maybe'], t.io)).toBe(1);
    expect(await runCli(['config', 'set', 'other', 'true'], t.io)).toBe(1);
    expect(t.err.join('\n')).not.toMatch(/\n\s+at /);
  });

  it('install claude prints the in-app commands when there is no claude CLI, with an optional marketplace', async () => {
    const t = io({ runs: () => ({ code: 127, stdout: '', stderr: 'not found' }) });
    expect(await runCli(['install', 'claude'], t.io)).toBe(0);
    expect(t.out.join('\n')).toContain('/plugin marketplace add Pandusss/conus');
    t.out.length = 0;
    expect(await runCli(['install', 'claude', '--marketplace', 'me/fork'], t.io)).toBe(0);
    expect(t.out.join('\n')).toContain('/plugin marketplace add me/fork');
    expect(await runCli(['install', 'vim'], t.io)).toBe(1);
  });

  it('install codex needs a login, then writes into --codex-home and the (overridden) home', async () => {
    const t = io({ fetchMap: WHOAMI_OK });
    const codexHome = join(t.dir, 'codex-home');
    expect(await runCli(['install', 'codex', '--codex-home', codexHome], t.io)).toBe(1);
    expect(t.err.join('\n')).toMatch(/conus setup/);
    expect(existsSync(codexHome)).toBe(false);

    await runCli(['login', 'https://conus.example.com', 'conus_1'], t.io);
    t.out.length = 0;
    expect(await runCli(['install', 'codex', '--codex-home', codexHome], t.io)).toBe(0);
    expect(readFileSync(join(codexHome, 'config.toml'), 'utf8')).toContain('command = "conus"\nargs = ["mcp"]');
    expect(readFileSync(join(codexHome, 'hooks.json'), 'utf8')).toContain('conus hook stop --agent codex');
    expect(existsSync(join(t.home, '.agents', 'skills', 'task-protocol', 'SKILL.md'))).toBe(true);
    expect(t.out.join('\n')).toContain('/hooks');
  });

  it('install rules writes the global block for every agent present and reports each file', async () => {
    const t = io();
    mkdirSync(join(t.home, '.claude'), { recursive: true });
    const codexHome = join(t.dir, 'codex-home');
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, 'AGENTS.md'), '# My own Codex rules\n');
    expect(await runCli(['install', 'rules', '--codex-home', codexHome], t.io)).toBe(0);
    expect(readFileSync(join(t.home, '.claude', 'CLAUDE.md'), 'utf8')).toBe(GLOBAL_RULES_BLOCK);
    expect(readFileSync(join(codexHome, 'AGENTS.md'), 'utf8')).toBe(`# My own Codex rules\n\n${GLOBAL_RULES_BLOCK}`);
    expect(existsSync(join(t.home, '.gemini'))).toBe(false);
    const out = t.out.join('\n');
    expect(out).toMatch(/Claude Code: created/);
    expect(out).toMatch(/Codex: updated/);
    expect(out).toMatch(/Gemini CLI: skipped/);
  });

  it('install codex takes CODEX_HOME from the environment', async () => {
    const t = io({ fetchMap: WHOAMI_OK });
    await runCli(['login', 'https://conus.example.com', 'conus_1'], t.io);
    const codexHome = join(t.dir, 'env-codex');
    expect(await runCli(['install', 'codex'], { ...t.io, env: { ...t.io.env, CODEX_HOME: codexHome } })).toBe(0);
    expect(existsSync(join(codexHome, 'config.toml'))).toBe(true);
  });

  it('install codex surfaces a refusal as a clear message with exit 1 (no stack trace, nothing written)', async () => {
    const t = io({ fetchMap: WHOAMI_OK });
    await runCli(['login', 'https://conus.example.com', 'conus_1'], t.io);
    const codexHome = join(t.dir, 'codex-home');
    mkdirSync(codexHome, { recursive: true });
    const handWritten = '[mcp_servers.conus]\nurl = "https://elsewhere.example/mcp"\n';
    writeFileSync(join(codexHome, 'config.toml'), handWritten);

    expect(await runCli(['install', 'codex', '--codex-home', codexHome], t.io)).toBe(1);
    const message = t.err.join('\n');
    expect(message).toContain('mcp_servers.conus');
    expect(message).not.toMatch(/\n\s+at /);
    expect(readFileSync(join(codexHome, 'config.toml'), 'utf8')).toBe(handWritten);
    expect(existsSync(join(codexHome, 'hooks.json'))).toBe(false);

    writeFileSync(join(codexHome, 'config.toml'), '# >>> conus >>>\n[mcp_servers.conus]\n');
    t.err.length = 0;
    expect(await runCli(['install', 'codex', '--codex-home', codexHome], t.io)).toBe(1);
    expect(t.err.join('\n')).toContain('unbalanced');
  });

  it('disable and enable work in the current git repo only', async () => {
    const repo = gitRepo();
    const t = io();
    expect(await runCli(['disable'], { ...t.io, cwd: repo })).toBe(0);
    expect(JSON.parse(readFileSync(join(repo, '.conus.json'), 'utf8'))).toEqual({ enabled: false });
    expect(t.out.join('\n')).toContain('Task tracking is off');
    expect(await runCli(['enable'], { ...t.io, cwd: repo })).toBe(0);
    expect(existsSync(join(repo, '.conus.json'))).toBe(false);

    const outside = io();
    expect(await runCli(['disable'], outside.io)).toBe(1);
    expect(outside.err.join('\n')).toContain('git');
    expect(await runCli(['enable'], outside.io)).toBe(1);
  });

  it('init --agents-md creates AGENTS.md, updates CLAUDE.md only when it exists, and is idempotent', async () => {
    const repo = gitRepo();
    const t = io();
    const at = { ...t.io, cwd: repo };
    expect(await runCli(['init', '--agents-md'], at)).toBe(0);
    expect(readFileSync(join(repo, 'AGENTS.md'), 'utf8')).toContain(AGENTS_MD_START);
    expect(existsSync(join(repo, 'CLAUDE.md'))).toBe(false);
    expect(t.out.join('\n')).toContain('AGENTS.md: created');

    writeFileSync(join(repo, 'CLAUDE.md'), '# Notes\n');
    expect(await runCli(['init', '--agents-md'], at)).toBe(0);
    expect(readFileSync(join(repo, 'CLAUDE.md'), 'utf8')).toContain(AGENTS_MD_END);
    expect(t.out.at(-1)).toBe('AGENTS.md: unchanged; CLAUDE.md: updated');

    expect(await runCli(['init'], at)).toBe(1);
    const outside = io();
    expect(await runCli(['init', '--agents-md'], outside.io)).toBe(1);
  });

  it('init --agents-md validates AGENTS.md and CLAUDE.md before writing either', async () => {
    const t = io();
    const brokenClaude = `# Claude
${AGENTS_MD_START}
no end marker
`;

    // AGENTS.md does not exist yet: a refusal on CLAUDE.md must not create it.
    const fresh = gitRepo();
    writeFileSync(join(fresh, 'CLAUDE.md'), brokenClaude);
    expect(await runCli(['init', '--agents-md'], { ...t.io, cwd: fresh })).toBe(1);
    expect(t.err.join('\n')).toMatch(/CLAUDE\.md.*start marker without an end marker/);
    expect(existsSync(join(fresh, 'AGENTS.md'))).toBe(false);
    expect(readFileSync(join(fresh, 'CLAUDE.md'), 'utf8')).toBe(brokenClaude);

    // AGENTS.md exists and would be updated: it must stay byte-identical.
    const existing = gitRepo();
    const agents = '# Agents\nsome notes\n';
    writeFileSync(join(existing, 'AGENTS.md'), agents);
    writeFileSync(join(existing, 'CLAUDE.md'), brokenClaude);
    t.err.length = 0;
    expect(await runCli(['init', '--agents-md'], { ...t.io, cwd: existing })).toBe(1);
    expect(readFileSync(join(existing, 'AGENTS.md'), 'utf8')).toBe(agents);
    expect(readFileSync(join(existing, 'CLAUDE.md'), 'utf8')).toBe(brokenClaude);
  });

  it('init --agents-md surfaces a marker refusal as a clear message with exit 1', async () => {
    const repo = gitRepo();
    const t = io();
    const broken = `# Mine\n${AGENTS_MD_START}\nno end marker\n`;
    writeFileSync(join(repo, 'AGENTS.md'), broken);
    expect(await runCli(['init', '--agents-md'], { ...t.io, cwd: repo })).toBe(1);
    expect(t.err.join('\n')).toMatch(/AGENTS\.md.*start marker without an end marker/);
    expect(t.err.join('\n')).not.toMatch(/\n\s+at /);
    expect(readFileSync(join(repo, 'AGENTS.md'), 'utf8')).toBe(broken);
  });
});

describe('conus setup', () => {
  const claudeOk = (_c: string, _a: string[]) => ({ code: 0, stdout: '', stderr: '' });

  it('logs in with the given URL and token, connects every agent present, adds the rules and runs doctor', async () => {
    const t = io({ fetchMap: HEALTHY, runs: claudeOk });
    for (const d of ['.claude', '.codex', '.gemini']) mkdirSync(join(t.home, d), { recursive: true });
    writeFileSync(join(t.home, '.gemini', 'settings.json'), '{"theme":"dark","mcpServers":{"other":{"command":"x"}}}');

    expect(await runCli(['setup', 'https://conus.example.com', 'conus_1', '--yes'], t.io)).toBe(0);
    const text = t.out.join('\n');
    expect(text).toContain('Logged in as claude-code@pc.');
    expect(t.execs).toEqual([
      ['claude', '--version'],
      ['claude', 'plugin', 'marketplace', 'add', 'Pandusss/conus'],
      ['claude', 'plugin', 'marketplace', 'update', 'conus'],
      ['claude', 'plugin', 'install', 'conus@conus', '--scope', 'user'],
    ]);
    expect(text).toContain('Claude Code: conus plugin installed');
    expect(readFileSync(join(t.home, '.codex', 'config.toml'), 'utf8')).toContain('[mcp_servers.conus]');
    expect(JSON.parse(readFileSync(join(t.home, '.gemini', 'settings.json'), 'utf8'))).toEqual({
      theme: 'dark', mcpServers: { other: { command: 'x' }, conus: { command: 'conus', args: ['mcp'] } },
    });
    expect(readFileSync(join(t.home, '.claude', 'CLAUDE.md'), 'utf8')).toContain(AGENTS_MD_START);
    expect(text).toMatch(/✓ token: agent claude-code@pc/);
    expect(t.asked).toEqual([]);
  });

  it('asks for the URL and token on a terminal when there is no working login', async () => {
    const noClaude = () => ({ code: 127, stdout: '', stderr: 'claude: not found' });
    const t = io({ fetchMap: HEALTHY, answers: [' https://conus.example.com ', 'conus_2', 'n'], runs: noClaude });
    expect(await runCli(['setup'], t.io)).toBe(0);
    expect(t.asked).toEqual(['Server URL: ', 'Agent token: ', "Add the Conus rule to your agents' global instructions? [Y/n] "]);
    expect(JSON.parse(readFileSync(configPath(t.dir), 'utf8'))).toMatchObject({ url: 'https://conus.example.com', token: 'conus_2' });
    expect(t.out.join('\n')).toContain('No agents found');
  });

  it('keeps a working login without asking, and needs arguments when it cannot ask', async () => {
    const t = io({ fetchMap: HEALTHY });
    expect(await runCli(['setup'], t.io)).toBe(1);
    expect(t.err.join('\n')).toContain('usage: conus setup <url> <token>');

    await runCli(['login', 'https://conus.example.com', 'conus_3'], t.io);
    t.out.length = 0;
    expect(await runCli(['setup', '--no-rules'], t.io)).toBe(0);
    expect(t.asked).toEqual(['Server URL: ']);
    expect(t.out[0]).toBe('Logged in as claude-code@pc.');
  });

  it('falls back to the in-app commands when the claude CLI fails, and --no-rules leaves the instructions alone', async () => {
    const t = io({
      fetchMap: HEALTHY,
      runs: (_c, a) => (a[0] === 'plugin' ? { code: 1, stdout: '', stderr: 'marketplace unreachable' } : { code: 0, stdout: '2.1', stderr: '' }),
    });
    mkdirSync(join(t.home, '.claude'), { recursive: true });
    expect(await runCli(['setup', 'https://conus.example.com', 'conus_4', '--no-rules'], t.io)).toBe(0);
    const text = t.out.join('\n');
    expect(text).toContain('marketplace unreachable');
    expect(text).toContain('/plugin install conus@conus');
    expect(existsSync(join(t.home, '.claude', 'CLAUDE.md'))).toBe(false);
  });

  it('stops at a failed login and installs nothing', async () => {
    const t = io({ fetchMap: { '/api/hooks/whoami': { status: 401 } }, runs: claudeOk });
    mkdirSync(join(t.home, '.codex'), { recursive: true });
    expect(await runCli(['setup', 'https://conus.example.com', 'conus_bad', '--yes'], t.io)).toBe(1);
    expect(existsSync(join(t.home, '.codex', 'config.toml'))).toBe(false);
  });
});

describe('conus logo', () => {
  /** A terminal with its own clock: sleeping only moves the clock. */
  function fakeTerminal(columns = 120) {
    let clock = 1000;
    const written: string[] = [];
    const term = {
      columns, write: (s: string) => { written.push(s); }, now: () => clock,
      sleep: async (ms: number) => { clock += ms; }, onInterrupt: () => () => {},
    };
    return { term, written };
  }

  it('prints the finished logo with the tagline when stdout is not a terminal', async () => {
    const t = io();
    expect(await runCli(['logo'], t.io)).toBe(0);
    const out = t.out.join('\n');
    expect(out).toContain('▄▀▀▀ ▄▀▀▄ █▀▀▄ █  █ ▄▀▀▀');
    expect(out).toContain('tasks your AI agents keep themselves');
    expect(out).toContain('▮');
    expect(out).not.toContain('\x1b');
    t.out.length = 0;
    await runCli(['logo'], { ...t.io, plainGlyphs: true });
    expect(t.out.join('\n')).not.toContain('▮');
  });

  it('assembles in place in a terminal: redraws over itself, hides the cursor and brings it back', async () => {
    const t = io();
    const { term, written } = fakeTerminal();
    expect(await runCli(['logo'], { ...t.io, terminal: term })).toBe(0);
    const all = written.join('');
    expect(written.length).toBeGreaterThan(60);
    expect(all.startsWith('\x1b[?25l')).toBe(true);
    expect(all.endsWith('\x1b[0m\x1b[?25h')).toBe(true);
    expect(all).toMatch(/\x1b\[13F/);
    expect(written.at(-2)).toContain('tasks your AI agents keep themselves');
    expect(t.out).toEqual([]);
  });

  it('skips the animation when the terminal is too narrow, and plays a short one before setup', async () => {
    const narrow = fakeTerminal(40);
    await runCli(['logo'], { ...io().io, terminal: narrow.term });
    expect(narrow.written).toEqual([]);
    const t = io({ fetchMap: HEALTHY });
    const { term, written } = fakeTerminal();
    expect(await runCli(['setup', 'https://conus.example.com', 'conus_1', '--no-rules'], { ...t.io, terminal: term })).toBe(0);
    expect(written.join('')).toContain('▮');
    expect(written.join('')).not.toContain('tasks your AI agents');
    expect(t.out.join('\n')).toContain('Logged in as claude-code@pc.');
  });
});

describe('installStdoutGuard', () => {
  const pipeError = (code: string) => Object.assign(new Error(`write ${code}`), { code });
  const fakes = () => ({ stream: new EventEmitter(), proc: { exitCode: undefined as number | string | null | undefined } });

  it('without a guard an async stream error is thrown (what the hook must survive)', () => {
    const { stream } = fakes();
    expect(() => stream.emit('error', pipeError('EPIPE'))).toThrow();
  });

  it('hook: EPIPE and any other stream error are swallowed and force exit code 0', () => {
    for (const code of ['EPIPE', 'EBADF', 'ENOSPC']) {
      const { stream, proc } = fakes();
      proc.exitCode = 1;
      installStdoutGuard(true, [stream], proc);
      expect(() => stream.emit('error', pipeError(code))).not.toThrow();
      expect(proc.exitCode).toBe(0);
    }
  });

  it('other commands: EPIPE is ignored, any other stream error is a plain exit code 1', () => {
    const a = fakes();
    installStdoutGuard(false, [a.stream], a.proc);
    expect(() => a.stream.emit('error', pipeError('EPIPE'))).not.toThrow();
    expect(a.proc.exitCode).toBeUndefined();
    expect(() => a.stream.emit('error', pipeError('ENOSPC'))).not.toThrow();
    expect(a.proc.exitCode).toBe(1);
  });

  it('guards every stream it is given', () => {
    const a = fakes(); const b = new EventEmitter();
    installStdoutGuard(true, [a.stream, b], a.proc);
    expect(() => b.emit('error', pipeError('EPIPE'))).not.toThrow();
    expect(a.proc.exitCode).toBe(0);
  });
});
