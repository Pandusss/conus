import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeHookInput } from '../src/hook/normalize';
import {
  analyzePowerShellScript, analyzeShellScript, claudeCallCommits, commitEvidence, exitCodeOf, extractFacts, patchFiles, relPath, runsGitCommit, sessionGitDir, shellCommand,
  isRelevantTool, type CommitEvidence, type Fact,
} from '../src/hook/facts';
import type { ReflogEntry } from '../src/git';
import { currentTurnToolCalls, lastAssistantModel, lastAssistantText, tailExcerpt, headExcerpt } from '../src/hook/transcript';
import { formatOutput } from '../src/hook/output';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (p: string) => JSON.parse(readFileSync(join(here, 'fixtures', p), 'utf8'));
const ROOT = 'C:/Users/me/repo';
const head = { sha: 'abc1234def0000000000000000000000000000ab', subject: 'feat: csv import' };

describe('normalize', () => {
  it('claude session-start and stop (shapes recorded from Claude Code 2.1.270)', () => {
    const s = normalizeHookInput('claude', fx('claude/session-start.json'))!;
    // A real SessionStart carries no model (claude -p, 2.1.270).
    expect(s).toMatchObject({ sessionId: 'cc-123', cwd: 'C:\\Users\\me\\repo', source: 'startup', model: null });
    const st = normalizeHookInput('claude', fx('claude/stop.json'))!;
    expect(st.stopHookActive).toBe(false);
    expect(st.lastAssistantMessage).toBe('Импорт CSV добавлен в src/import.ts, npm test проходит.');
    expect(normalizeHookInput('claude', fx('claude/stop-transcript-only.json'))!.lastAssistantMessage).toBeNull();
    expect(normalizeHookInput('claude', fx('claude/session-end.json'))!.reason).toBe('other');
  });
  it('codex stop carries last_assistant_message', () => {
    expect(normalizeHookInput('codex', fx('codex/stop.json'))!.lastAssistantMessage).toBe('Импорт готов, тесты зелёные.');
  });
  it('rejects payloads without session id or cwd', () => {
    expect(normalizeHookInput('claude', { cwd: '/x' })).toBeNull();
    expect(normalizeHookInput('claude', 'str')).toBeNull();
  });
});

describe('paths and parsing', () => {
  it.each([
    ['C:/Users/me/repo', 'C:\\Users\\me\\repo\\src\\a.ts', 'src/a.ts'],
    ['C:/Users/me/repo', 'c:\\users\\me\\repo\\src\\a.ts', 'src/a.ts'],
    ['C:/Users/me/repo', '/c/Users/me/repo/src/a.ts', 'src/a.ts'],
    ['/home/me/repo', '/home/me/repo/lib/b.py', 'lib/b.py'],
    ['/home/me/repo', './lib/b.py', 'lib/b.py'],
    ['/home/me/repo', '/etc/hosts', '/etc/hosts'],
  ])('relPath(%s, %s) = %s', (root, file, out) => expect(relPath(root, file)).toBe(out));

  it('parses apply_patch file headers', () => {
    expect(patchFiles('*** Begin Patch\n*** Update File: a.ts\n*** Add File: b/c.ts\n*** Delete File: d.ts\n*** Move to: e.ts\n*** End Patch'))
      .toEqual(['a.ts', 'b/c.ts', 'd.ts', 'e.ts']);
  });
  it('extracts shell commands', () => {
    expect(shellCommand({ command: 'npm test' })).toBe('npm test');
    expect(shellCommand({ command: ['bash', '-lc', 'npm test'] })).toBe('npm test');
    expect(shellCommand({ command: ['git', 'commit', '-m', 'x'] })).toBe('git commit -m x');
    expect(shellCommand({})).toBeNull();
  });
  it('reads exit codes', () => {
    expect(exitCodeOf({ exit_code: 0 })).toBe(0);
    expect(exitCodeOf('Exit code: 1\nOutput:')).toBe(1);
    expect(exitCodeOf({ is_error: true })).toBe(1);
    expect(exitCodeOf({ stdout: 'x' })).toBeNull();
  });
  it('knows relevant tools', () => {
    expect(isRelevantTool('Read')).toBe(false);
    expect(isRelevantTool('Edit')).toBe(true);
    expect(isRelevantTool('mcp__conus__task_start')).toBe(true);
    expect(isRelevantTool('mcp__linear__task_create')).toBe(false);
    expect(isRelevantTool('mcp__html_tools__task_create')).toBe(false);
  });
});

describe('Windows paths (review focus #3)', () => {
  it.each([
    ['C:/Users/me/repo', 'C:/Users/me/repo\\src/a.ts', 'src/a.ts'],
    ['c:/users/me/repo', 'C:\\Users\\me\\repo\\src\\a.ts', 'src/a.ts'],
    ['C:\\Users\\me\\repo', '/c/Users/me/repo/src/a.ts', 'src/a.ts'],
    ['/c/Users/me/repo', 'C:\\Users\\me\\repo\\src\\a.ts', 'src/a.ts'],
    ['C:/Users/me/repo/', 'C:\\Users\\me\\repo\\src\\a.ts', 'src/a.ts'],
    ['C:/Users/me/repo', 'src\\lib\\a.ts', 'src/lib/a.ts'],
  ])('relPath(%s, %s) = %s', (root, file, out) => expect(relPath(root, file)).toBe(out));
});

describe('sessionGitDir: commit detection asks git in the session root, never the shell cwd (N1 round 4)', () => {
  it.each([
    ['C:/Users/me/repo', 'C:\\Users\\me\\repo\\scratch', 'win32', 'C:/Users/me/repo'],
    ['/c/Users/me/repo', 'C:\\Users\\me\\repo\\scratch', 'win32', 'C:/Users/me/repo'],
    ['/c/Users/me/repo', '/c/Users/me/repo/scratch', 'linux', '/c/Users/me/repo'],
    ['/home/me/repo', '/home/me/repo/scratch', 'linux', '/home/me/repo'],
    ['', 'C:\\Users\\me\\repo', 'win32', 'C:\\Users\\me\\repo'],
  ] as const)('sessionGitDir(%s, %s, %s) = %s', (root, cwd, platform, out) => expect(sessionGitDir(root, cwd, platform)).toBe(out));
});

describe('extractFacts (contract)', () => {
  // Claude: commits of this repo named by gitOperation (or in the call's reflog window); Codex: a `git commit` command and the new HEAD.
  const run = (agent: 'claude' | 'codex', file: string, h: typeof head | null = head) =>
    extractFacts(normalizeHookInput(agent, fx(file))!, ROOT, {
      headCommit: () => h, assumeSuccess: agent === 'claude', commits: agent === 'claude' ? 'claude' : 'head',
      claudeCommits: (call) => claudeCallCommits({ ...call, window: null }, { reflog: null, resolve: (sha) => (h && h.sha.startsWith(sha.toLowerCase()) ? h : null) }),
    });

  it('claude edit → file_edit relative', () => expect(run('claude', 'claude/tool-edit.json')).toEqual([{ kind: 'file_edit', data: { path: 'src/import.ts' } }]));
  it('claude commit → git_commit (sha and subject from git, branch from gitOperation)', () =>
    expect(run('claude', 'claude/tool-bash-commit.json')).toEqual([{ kind: 'git_commit', data: { ...head, branch: 'main' } }]));
  it('claude commit that is not a commit of this repo (git cannot resolve it) → nothing', () =>
    expect(run('claude', 'claude/tool-bash-commit.json', null)).toEqual([]));
  it('claude tests → passed (PostToolUse implies success)', () =>
    expect(run('claude', 'claude/tool-bash-test.json')).toEqual([{ kind: 'test_run', data: { passed: true, command: 'npm test' } }]));
  it('claude Bash that writes files → one file_edit per changed file (bashEditDiff), never the diff itself', () => {
    const facts = run('claude', 'claude/tool-bash-write.json');
    expect(facts).toEqual([{ kind: 'file_edit', data: { path: 'src/import.ts' } }, { kind: 'file_edit', data: { path: 'README.md' } }]);
    expect(JSON.stringify(facts)).not.toContain('importCsv');
  });
  it('claude Bash commit reported only by gitOperation (command not recognised) → git_commit', () => {
    const input = normalizeHookInput('claude', {
      session_id: 's-1', cwd: 'C:\\Users\\me\\repo', tool_name: 'Bash', tool_input: { command: 'npm run release' },
      tool_response: { stdout: '', stderr: '', interrupted: false, gitOperation: { commit: { sha: 'abc1234', kind: 'committed', branch: 'main' } } },
    })!;
    expect(extractFacts(input, ROOT, { headCommit: () => head, assumeSuccess: true })).toEqual([{ kind: 'git_commit', data: head }]);
    expect(extractFacts(input, ROOT, { headCommit: () => null, assumeSuccess: true })).toEqual([]);
  });
  it('`amends` comes from the reflog only (HEAD@{1} of a `commit (amend)`), never from the command or a saved HEAD', () => {
    const prev = 'f'.repeat(40);
    const bash = (command: string, gitOperation?: unknown) => normalizeHookInput('claude', {
      session_id: 's-1', cwd: 'C:\\Users\\me\\repo', tool_name: 'Bash', tool_input: { command },
      tool_response: { stdout: '', stderr: '', interrupted: false, ...(gitOperation ? { gitOperation } : {}) },
    })!;
    const asked: string[] = [];
    const deps = (replaced: string | null) => ({ headCommit: () => head, assumeSuccess: true, amends: (sha: string) => { asked.push(sha); return replaced; } });
    // Live run (Task 21): a broken message fixed with `git commit --amend -F - <<'EOF'`
    expect(extractFacts(bash("git commit --amend -F - <<'EOF'\nAdd --json flag\nEOF"), ROOT, deps(prev)))
      .toEqual([{ kind: 'git_commit', data: { ...head, amends: prev } }]);
    expect(asked).toEqual([head.sha]);
    expect(extractFacts(bash('npm run fixup', { commit: { sha: 'abc1234', kind: 'amended', branch: 'main' } }), ROOT, deps(prev)))
      .toEqual([{ kind: 'git_commit', data: { ...head, amends: prev } }]);
    // the reflog says it was not an amend (or cannot tell): no amends, whatever the command looked like
    expect(extractFacts(bash('git commit --amend --no-edit'), ROOT, deps(null))).toEqual([{ kind: 'git_commit', data: head }]);
    expect(extractFacts(bash('git commit --amend --no-edit'), ROOT, { headCommit: () => head, assumeSuccess: true })).toEqual([{ kind: 'git_commit', data: head }]);
    // unusable answers are ignored
    expect(extractFacts(bash('git commit --amend --no-edit'), ROOT, deps('not-a-sha'))).toEqual([{ kind: 'git_commit', data: head }]);
    expect(extractFacts(bash('git commit --amend --no-edit'), ROOT, deps(head.sha))).toEqual([{ kind: 'git_commit', data: head }]);
  });
  it('bashEditDiff: falls back to files[].filePath, drops paths outside the repo, dedups', () => {
    const input = normalizeHookInput('claude', {
      session_id: 's-1', cwd: 'C:\\Users\\me\\repo', tool_name: 'Bash', tool_input: { command: 'node gen.js' },
      tool_response: { stdout: '', bashEditDiff: { files: [
        { filePath: 'C:\\Users\\me\\repo\\gen\\a.ts', hunks: [] }, { filePath: 'C:\\Windows\\x.ini', hunks: [] },
        { filePath: 'C:\\Users\\me\\repo\\gen\\a.ts', hunks: [] }, { filePath: 42 },
      ] } },
    })!;
    expect(extractFacts(input, ROOT, { headCommit: () => null, assumeSuccess: true })).toEqual([{ kind: 'file_edit', data: { path: 'gen/a.ts' } }]);
  });
  it('claude conus MCP call → task_op', () =>
    expect(run('claude', 'claude/tool-mcp.json')).toEqual([{ kind: 'task_op', data: { tool: 'task_start', task: 'WB-42' } }]));
  it('codex patch → two file_edits', () =>
    expect(run('codex', 'codex/tool-patch.json')).toEqual([
      { kind: 'file_edit', data: { path: 'src/import.ts' } },
      { kind: 'file_edit', data: { path: 'src/csv.ts' } },
    ]));
  it('codex shell tests with exit code', () =>
    expect(run('codex', 'codex/tool-shell.json')).toEqual([{ kind: 'test_run', data: { passed: true, command: 'npm test' } }]));
});

describe('extractFacts (privacy and server limits)', () => {
  const mk = (toolName: string, toolInput: unknown, cwd = 'C:\\Users\\me\\repo') =>
    normalizeHookInput('claude', { session_id: 's-1', cwd, tool_name: toolName, tool_input: toolInput })!;
  const deps = { headCommit: () => null, assumeSuccess: true };

  it('drops edits outside the repo root: no absolute path leaves the machine', () => {
    expect(extractFacts(mk('Edit', { file_path: '/etc/hosts' }), ROOT, deps)).toEqual([]);
    expect(extractFacts(mk('Edit', { file_path: '/etc/hosts' }, '/home/me/repo'), '/home/me/repo', deps)).toEqual([]);
    expect(extractFacts(mk('Write', { file_path: 'C:\\other\\x.ts' }), ROOT, deps)).toEqual([]);
    expect(extractFacts(mk('Edit', { file_path: 'D:\\Users\\me\\repo\\x.ts' }), ROOT, deps)).toEqual([]);
    expect(extractFacts(mk('Edit', { file_path: 'C:\\Users\\me\\repo-other\\x.ts' }), ROOT, deps)).toEqual([]);
    expect(extractFacts(mk('Edit', { file_path: '\\\\server\\share\\x.ts' }), ROOT, deps)).toEqual([]);
    expect(extractFacts(mk('Edit', { file_path: 'C:\\Users\\me\\repo' }), ROOT, deps)).toEqual([]);
  });
  it('drops patch entries that climb out of the repo, keeps the rest', () => {
    const patch = '*** Begin Patch\n*** Update File: ../outside.ts\n*** Update File: src/ok.ts\n*** Add File: src/../../escape.ts\n*** Delete File: /tmp/abs.ts\n*** End Patch';
    expect(extractFacts(mk('apply_patch', patch), ROOT, deps)).toEqual([{ kind: 'file_edit', data: { path: 'src/ok.ts' } }]);
    expect(extractFacts(mk('shell', { command: ['bash', '-lc', `apply_patch <<'EOF'\n${patch}\nEOF`] }), ROOT, deps))
      .toEqual([{ kind: 'file_edit', data: { path: 'src/ok.ts' } }]);
  });
  it('resolves relative tool paths against the session cwd, so a subdirectory cwd still yields repo-relative paths', () => {
    const sub = 'C:\\Users\\me\\repo\\packages\\cli';
    expect(extractFacts(mk('apply_patch', { input: '*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: ../core/b.ts\n*** End Patch' }, sub), ROOT, deps))
      .toEqual([{ kind: 'file_edit', data: { path: 'packages/cli/src/a.ts' } }, { kind: 'file_edit', data: { path: 'packages/core/b.ts' } }]);
    expect(extractFacts(mk('Edit', { file_path: 'C:\\Users\\me\\repo\\README.md' }, sub), ROOT, deps)).toEqual([{ kind: 'file_edit', data: { path: 'README.md' } }]);
    expect(extractFacts(mk('apply_patch', '*** Begin Patch\n*** Update File: ../../../x.ts\n*** End Patch', sub), ROOT, deps)).toEqual([]);
  });
  it('never emits facts the server would reject (whole batch would be dropped)', () => {
    expect(extractFacts(mk('Edit', { file_path: 'src/' + 'a'.repeat(500) + '.ts' }), ROOT, deps)).toEqual([]);
    expect(extractFacts(mk('Edit', { file_path: '' }), ROOT, deps)).toEqual([]);
    expect(extractFacts(mk('mcp__conus__task_start', { task: 'X'.repeat(31) }), ROOT, deps)).toEqual([{ kind: 'task_op', data: { tool: 'task_start' } }]);
    const badSha = { headCommit: () => ({ sha: 'not-a-sha', subject: 's' }), assumeSuccess: true };
    expect(extractFacts(mk('Bash', { command: 'git commit -m x' }), ROOT, badSha)).toEqual([]);
  });
});

describe('shell scripts: test runs and commits only at command position', () => {
  const quiet = { stdout: '', stderr: '', interrupted: false };
  const sh = (command: unknown, toolResponse: unknown = quiet, agent: 'claude' | 'codex' = 'claude') =>
    extractFacts(
      normalizeHookInput(agent, { session_id: 's-1', cwd: 'C:\\Users\\me\\repo', tool_name: agent === 'claude' ? 'Bash' : 'shell', tool_input: { command }, tool_response: toolResponse })!,
      ROOT, { headCommit: () => head, assumeSuccess: agent === 'claude' },
    );
  const testRuns = (facts: Fact[]) => facts.filter((f) => f.kind === 'test_run');

  it.each([
    'npm install -D vitest',
    'cat jest.config.js',
    'rg pytest',
    'pnpm add -D jest',
    'echo "npm test"',
    'grep -rn "go test" docs',
    'git log --grep pytest',
  ])('%s → no test_run', (command) => expect(testRuns(sh(command))).toEqual([]));

  it('a commit message that mentions a runner is a commit, not a test run', () => {
    expect(sh('git commit -m "chore: add vitest"')).toEqual([{ kind: 'git_commit', data: head }]);
    expect(sh(['git', 'commit', '-m', 'fix && npm test'], 'Exit code: 0\nOutput:\n', 'codex')).toEqual([{ kind: 'git_commit', data: head }]);
  });

  it('heredoc bodies are neither matched nor sent', () => {
    expect(sh("cat > notes.md <<'EOF'\nrun jest --ci before release\ngit commit -am secret\nEOF")).toEqual([]);
    expect(sh('python - <<-PY\n\timport pytest\n\tPY\nls')).toEqual([]);
    // Any heredoc in the script: no test command at all (fix round 3).
    const facts = sh('cat <<EOF > ci.sh && npm test\njest --secret-body\nEOF\n');
    expect(facts).toEqual([]);
    expect(JSON.stringify(facts)).not.toContain('secret-body');
    expect(sh('cat <<EOF\njest body\nEOF')).toEqual([]);
    // Commit detection skips bodies and resumes after the delimiter, also with two heredocs on one line.
    expect(sh('cat <<A <<-B\ngit commit -m a-body\nA\n\tgit commit -m b-body\n\tB\nls')).toEqual([]);
    expect(sh('cat <<A <<-B\nx\nA\n\ty\n\tB\ngit commit -am x')).toEqual([{ kind: 'git_commit', data: head }]);
  });

  it('an apply_patch diff that mentions tests and commits yields only its file edits', () => {
    const script = "apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: package.json\n@@\n+    \"test\": \"vitest run\",\n+    \"ci\": \"npm test && git commit -am x\"\n*** End Patch\nPATCH";
    expect(sh(script)).toEqual([{ kind: 'file_edit', data: { path: 'package.json' } }]);
  });

  it.each([
    ['cd app && npm test', 'npm test'],
    ['CI=1 npx vitest run', 'npx vitest run'],
    ['npm test 2>&1 | tail -20', 'npm test 2>&1'],
    ['npm ci\nnpm test # everything', 'npm test'],
    ['npm run test:unit -- --reporter=dot', 'npm run test:unit -- --reporter=dot'],
    ['yarn vitest --run', 'yarn vitest --run'],
    ['pnpm exec jest src', 'pnpm exec jest src'],
    ['(cd api; python -m pytest -q)', 'python -m pytest -q'],
    ['go test ./...', 'go test ./...'],
    ['cargo test --all', 'cargo test --all'],
    ['./gradlew clean test', './gradlew clean test'],
    ['mvn -q test', 'mvn -q test'],
    ['dotnet test', 'dotnet test'],
    ['node --test test/', 'node --test test/'],
    ['bun test', 'bun test'],
    ['deno test -A', 'deno test -A'],
  ])('%s → test_run with command %s', (script, command) =>
    expect(testRuns(sh(script))).toEqual([{ kind: 'test_run', data: { passed: true, command } }]));

  it('detects git commit only as a command', () => {
    expect(sh('git add -A && git -C sub commit -m "x"')).toEqual([{ kind: 'git_commit', data: head }]);
    expect(sh('echo "remember to git commit"')).toEqual([]);
    expect(sh('git log --grep commit')).toEqual([]);
    expect(sh('cat <<EOF\ngit commit -m x\nEOF')).toEqual([]);
    // Claude Code's usual commit idiom: message in a heredoc inside a command substitution.
    expect(sh(`git add -A && git commit -m "$(cat <<'EOF'\nfeat: run jest in CI, don't skip\n\nCo-Authored-By: x\nEOF\n)"`)).toEqual([{ kind: 'git_commit', data: head }]);
  });

  it.each([
    ["cat <<'---'\njest SECRET3\n---", 'SECRET3'],
    ['cat <<1\njest SECRET1\n1', 'SECRET1'],
    ['cat <<"END OF"\njest SECRET2\nEND OF', 'SECRET2'],
    ['cat <<EOF"x"\njest SECRET4\nEOF\n', 'SECRET4'],
    ['jest -t "x <<EOF\n" && echo "\nEOF\nSECRET_LINE"', 'SECRET_LINE'],
  ])('fails closed on %j: no secret text in any fact', (script, secret) => {
    const facts = sh(script);
    expect(JSON.stringify(facts)).not.toContain(secret);
    expect(testRuns(facts)).toEqual([]);
  });

  it('an unrecognised heredoc ends commit detection after its line; the line itself still counts', () => {
    expect(sh('cat <<1\nfoo\n1\ngit commit -am x')).toEqual([]);
    expect(sh('git commit -am x; cat <<1\ngit commit -m y\n1')).toEqual([{ kind: 'git_commit', data: head }]);
    expect(sh('npm test; cat <<1\njest x\n1')).toEqual([]);
  });

  const NBSP = String.fromCharCode(0xa0);
  it.each([
    ['NBSP after a heredoc delimiter', `cat <<EOF${NBSP}x\nEOF\njest SECRET_NBSP\nEOF${NBSP}x\nnpm test`, 'SECRET_NBSP'],
    ['backslash-newline inside the heredoc operator', 'cat <\\\n<EOF\njest SECRET_LC\nEOF', 'SECRET_LC'],
    ['ANSI-C quoting', "printf $'\\' ; jest SECRET_PRINTF ; \\'' # '", 'SECRET_PRINTF'],
    ['CRLF line continuation', 'npm test \\\r\n  --ci SECRET_CRLF', 'SECRET_CRLF'],
    ['a quoted heredoc operator', 'npm test SECRET_Q && echo "<<"', 'SECRET_Q'],
  ])('no test command where bash may read the script differently: %s', (_name, script, secret) => {
    expect(analyzeShellScript(script).testCommand).toBeNull();
    const facts = sh(script);
    expect(testRuns(facts)).toEqual([]);
    expect(JSON.stringify(facts)).not.toContain(secret);
  });

  it('still reports plain commands: npm test, a here-string, and the heredoc commit idiom', () => {
    expect(sh('npm test')).toEqual([{ kind: 'test_run', data: { passed: true, command: 'npm test' } }]);
    expect(testRuns(sh('cat <<< "y" && npm test'))).toEqual([{ kind: 'test_run', data: { passed: true, command: 'npm test' } }]);
    expect(sh(`git commit -m "$(cat <<'EOF'\nmsg\nEOF\n)"`)).toEqual([{ kind: 'git_commit', data: head }]);
  });

  it('a quoted `<<` or unbalanced quotes suppress the test_run command, but not a commit', () => {
    expect(sh('git commit -m "a <<b" && npm test')).toEqual([{ kind: 'git_commit', data: head }]);
    expect(sh('npm test && echo "unterminated')).toEqual([]);
    expect(sh("npm test && echo it's")).toEqual([]);
    expect(sh('npm test && echo "it\'s fine"')).toEqual([{ kind: 'test_run', data: { passed: true, command: 'npm test' } }]);
  });

  it('never scans Claude stdout for an exit code; Codex only by a leading `Exit code: N`', () => {
    const noisy = { stdout: 'npm ERR! code ELIFECYCLE\nnpm ERR! exit code: 1 (in a dependency log)', stderr: '', interrupted: false };
    expect(sh('npm test', noisy)).toEqual([{ kind: 'test_run', data: { passed: true, command: 'npm test' } }]);
    expect(sh('git commit -m x', { stdout: 'pre-commit: exit code: 1 ignored', stderr: '', interrupted: false })).toEqual([{ kind: 'git_commit', data: head }]);
    expect(sh('npm test', 'Exit code: 1\nWall time: 2 seconds\nOutput:\nFAIL', 'codex')).toEqual([{ kind: 'test_run', data: { passed: false, command: 'npm test' } }]);
    expect(exitCodeOf({ output: 'Exit code: 2\nOutput:\n' })).toBe(2);
    expect(exitCodeOf('Output:\nexit code: 1')).toBeNull();
    expect(exitCodeOf({ stdout: 'Exit code: 1' })).toBeNull();
  });
});

describe('Claude: commits of this repo only — named by gitOperation, or in the call\'s reflog window (N1 round 3)', () => {
  const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40), F = 'f'.repeat(40);
  const NOW = 1_800_000_000_000;
  // This repo's HEAD reflog, newest first: B committed 1 s ago, A ten minutes ago.
  const log: ReflogEntry[] = [
    { sha: B, time: NOW - 1000, action: 'commit: feat: b', subject: 'feat: b' },
    { sha: A, time: NOW - 600_000, action: 'commit: feat: a', subject: 'feat: a' },
  ];
  const known = new Map([[A, 'feat: a'], [B, 'feat: b'], [C, 'feat: c']]);
  const repo = (reflog: ReflogEntry[] | null = log) => ({
    reflog, resolve: (sha: string) => { const full = [...known.keys()].find((k) => k.startsWith(sha.toLowerCase())); return full ? { sha: full, subject: known.get(full)! } : null; },
  });
  const ev = (sha: string, kind = 'committed', branch: string | null = 'main'): CommitEvidence => ({ sha, kind, branch });
  const call = (evidence: CommitEvidence | null, ranCommit: boolean, window: { from: number; to: number } | null = { from: NOW - 3000, to: NOW }) => ({ evidence, ranCommit, window });

  it('(i) gitOperation names a commit of this repo → reported, with its branch (from the reflog, or resolved by git)', () => {
    expect(claudeCallCommits(call(ev('bbbbbbb'), true), repo())).toEqual([{ sha: B, subject: 'feat: b', branch: 'main' }]);
    expect(claudeCallCommits(call(ev('ccccccc'), false, null), repo())).toEqual([{ sha: C, subject: 'feat: c', branch: 'main' }]);
  });

  it('gitOperation naming a commit of ANOTHER repo (git -C other, a scratch repo) → nothing; unresolvable or a git error → nothing', () => {
    expect(claudeCallCommits(call(ev('3ee1187'), true, { from: NOW - 10, to: NOW }), repo())).toEqual([]);
    expect(claudeCallCommits(call(ev('3ee1187'), false, null), repo(null))).toEqual([]);
  });

  it('(ii) a quiet commit (no gitOperation): `git commit` ran and a reflog commit entry lies in the call window → reported', () => {
    expect(claudeCallCommits(call(null, true), repo())).toEqual([{ sha: B, subject: 'feat: b' }]);
  });

  it('(ii) needs all of: a `git commit` command, a window, a commit action inside it', () => {
    expect(claudeCallCommits(call(null, false), repo())).toEqual([]); // no git commit in the call
    expect(claudeCallCommits(call(null, true, null), repo())).toEqual([]); // no window (no duration in the payload)
    expect(claudeCallCommits(call(null, true, { from: NOW - 500, to: NOW }), repo())).toEqual([]); // B is older: another session's
    const checkout: ReflogEntry[] = [{ sha: C, time: NOW - 1000, action: 'checkout: moving from main to feat', subject: 'feat: c' }, ...log];
    expect(claudeCallCommits(call(null, true), repo(checkout))).toEqual([{ sha: B, subject: 'feat: b' }]);
    expect(claudeCallCommits(call(null, true), repo(null))).toEqual([]); // git failed
  });

  it('several commits in one call → all, oldest first; amends = HEAD@{1} only for the reflog top `commit (amend)`', () => {
    const two: ReflogEntry[] = [
      { sha: C, time: NOW - 500, action: 'commit (amend): feat: c', subject: 'feat: c' },
      { sha: B, time: NOW - 1000, action: 'commit: feat: b', subject: 'feat: b' },
      ...log.slice(1),
    ];
    expect(claudeCallCommits(call(null, true), repo(two))).toEqual([{ sha: B, subject: 'feat: b' }, { sha: C, subject: 'feat: c', amends: B }]);
    // gitOperation names the newest one too: still once each
    expect(claudeCallCommits(call(ev('ccccccc', 'amended'), true), repo(two))).toEqual([{ sha: B, subject: 'feat: b' }, { sha: C, subject: 'feat: c', branch: 'main', amends: B }]);
    // an amend that is no longer the reflog top: no amends
    expect(claudeCallCommits(call(ev('ccccccc', 'amended'), false, null), repo([{ sha: F, time: NOW, action: 'commit: later', subject: 'later' }, ...two])))
      .toEqual([{ sha: C, subject: 'feat: c', branch: 'main' }]);
  });

  it('extractFacts (claude mode) asks only for a call with a record or a `git commit` command, whatever its exit code', () => {
    const shell = (tool: string, command: string, gitOperation?: unknown, extra: Record<string, unknown> = {}) => normalizeHookInput('claude', {
      session_id: 's-1', cwd: 'C:\\Users\\me\\repo', tool_name: tool, tool_input: { command },
      tool_response: { stdout: '', stderr: '', interrupted: false, ...extra, ...(gitOperation ? { gitOperation } : {}) },
    })!;
    const asked: unknown[] = [];
    const deps = {
      assumeSuccess: true, commits: 'claude' as const,
      headCommit: () => { throw new Error('a Claude commit never reads HEAD'); },
      claudeCommits: (c: { evidence: CommitEvidence | null; ranCommit: boolean }) => { asked.push(c); return claudeCallCommits({ ...c, window: { from: NOW - 3000, to: NOW } }, repo()); },
    };
    expect(extractFacts(shell('Bash', 'npm run build'), ROOT, deps)).toEqual([]);
    expect(asked).toEqual([]);
    // a quiet commit, then a failing test in the same call: the commit counts
    expect(extractFacts(shell('PowerShell', 'git commit -q -m b; npm test', undefined, { is_error: true }), ROOT, deps))
      .toEqual([{ kind: 'git_commit', data: { sha: B, subject: 'feat: b' } }, { kind: 'test_run', data: { passed: false, command: 'npm test' } }]);
    expect(asked).toEqual([{ evidence: null, ranCommit: true }]);
    // a commit in another repo with a record: nothing
    expect(extractFacts(shell('Bash', 'git -C ../other commit -m x', { commit: { sha: '3ee1187', kind: 'committed', branch: 'main' } }), ROOT, { ...deps, claudeCommits: (c) => claudeCallCommits({ ...c, window: { from: NOW - 10, to: NOW } }, repo()) }))
      .toEqual([]);
    expect(commitEvidence({ gitOperation: { commit: { sha: 'xyz' } } })).toBeNull();
    expect(commitEvidence({ gitOperation: { commit: { sha: 'abc1234', kind: 'amended', branch: 'main' } } })).toEqual({ sha: 'abc1234', kind: 'amended', branch: 'main' });
  });

  it('runsGitCommit picks the parser by tool (the Stop path reads the call from the transcript)', () => {
    expect(runsGitCommit('Bash', 'git add -A && git commit -q -m x')).toBe(true);
    expect(runsGitCommit('PowerShell', 'if ($?) { git commit -m x }')).toBe(true);
    expect(runsGitCommit('PowerShell', 'Write-Host "git commit"')).toBe(false);
    expect(runsGitCommit('Edit', 'git commit')).toBe(false);
  });
});

describe('PowerShell (Claude Code on Windows, CLAUDE_CODE_USE_POWERSHELL_TOOL=1)', () => {
  it('recorded payload: a commit inside `if ($?) { … }` with a here-string message → git_commit from its gitOperation', () => {
    expect(isRelevantTool('PowerShell')).toBe(true);
    const input = normalizeHookInput('claude', fx('claude/tool-powershell-commit.json'))!;
    expect(input.toolName).toBe('PowerShell');
    const full = { sha: '1cbc0fc' + '0'.repeat(33), subject: 'docs: add notes' };
    const claude = {
      assumeSuccess: true, commits: 'claude' as const, headCommit: () => null,
      claudeCommits: (call: { evidence: CommitEvidence | null; ranCommit: boolean }) =>
        claudeCallCommits({ ...call, window: null }, { reflog: null, resolve: (sha) => (full.sha.startsWith(sha) ? full : null) }),
    };
    expect(extractFacts(input, ROOT, claude)).toEqual([{ kind: 'git_commit', data: { ...full, branch: 'main' } }]);
    // the command parser alone (what Codex-style HEAD detection would use) also sees the commit
    expect(extractFacts(input, ROOT, { headCommit: () => head, assumeSuccess: true })).toEqual([{ kind: 'git_commit', data: head }]);
  });

  it.each([
    'git add -A; git commit -m x',
    'git add -A && git commit -m x',
    'git diff --quiet || git commit -am x',
    'git status | Out-Null; git commit -m x',
    'git add -A\ngit commit -m x',
    'git add -A\r\ngit commit -m x',
    'if ($?) { git commit -m x }',
    '& git commit -m x',
    "& 'C:\\Program Files\\Git\\cmd\\git.exe' commit -m x",
    'git.exe -C sub commit -m x',
    "try { git commit -m 'a; b' } catch { Write-Host $_ }",
    '$out = git commit -m x',
  ])('git commit in command position: %s', (script) => expect(analyzePowerShellScript(script).commit).toBe(true));

  it.each([
    'Write-Host "git commit -m x"',
    "echo 'git commit'",
    'git log --grep commit',
    '# git commit -m x',
    '<# git commit -m x #> git status',
    "git tag -a v1 -m @'\ngit commit -m x\n'@",
    'git commit-tree HEAD^{tree}',
    "Write-Host 'it''s; git commit'",
  ])('not a git commit: %s', (script) => expect(analyzePowerShellScript(script).commit).toBe(false));

  it('test runs follow the Bash runner rules; the command starts at its command word', () => {
    expect(analyzePowerShellScript('npm test').testCommand).toBe('npm test');
    expect(analyzePowerShellScript('Set-Location sub; npx vitest run --reporter dot').testCommand).toBe('npx vitest run --reporter dot');
    expect(analyzePowerShellScript('npm.cmd test 2>&1 | Select-String fail').testCommand).toBe('npm.cmd test 2>&1');
    expect(analyzePowerShellScript('$r = npm test').testCommand).toBe('npm test');
    expect(analyzePowerShellScript('Write-Host "npm test"').testCommand).toBeNull();
    expect(analyzePowerShellScript('git status').testCommand).toBeNull();
  });

  it.each([
    ['a here-string', "$m = @'\nnot a command\n'@\nnpm test"],
    ['a double-quoted here-string', '$m = @"\nx\n"@; npm test'],
    ['a backtick line continuation', 'npm test `\n  --silent'],
    ['-EncodedCommand', 'npm test; powershell -EncodedCommand ZQBjAGgAbwA='],
    ['an abbreviated -enc', 'pwsh -enc ZQBjAGgAbwA=; npm test'],
  ])('fails closed (no test command) with %s; commit detection is unaffected', (_name, script) => {
    expect(analyzePowerShellScript(script).testCommand).toBeNull();
    expect(analyzePowerShellScript(`${script}\ngit commit -m x`).commit).toBe(true);
  });

  it('a PowerShell tool call is normalized like Bash: test_run passed (Claude: PostToolUse implies success), commit from gitOperation', () => {
    const call = (command: string, extra: Record<string, unknown> = {}) => normalizeHookInput('claude', {
      session_id: 's-1', cwd: 'C:\\Users\\me\\repo', tool_name: 'PowerShell', tool_input: { command, description: 'x' },
      tool_response: { stdout: 'ok', stderr: '', interrupted: false, isImage: false, ...extra },
    })!;
    expect(extractFacts(call('npm test'), ROOT, { headCommit: () => head, assumeSuccess: true }))
      .toEqual([{ kind: 'test_run', data: { passed: true, command: 'npm test' } }]);
    expect(extractFacts(call('npm run release', { gitOperation: { commit: { sha: 'abc1234', kind: 'committed', branch: 'main' } } }), ROOT, { headCommit: () => head, assumeSuccess: true }))
      .toEqual([{ kind: 'git_commit', data: head }]);
    expect(extractFacts(call('npm test', { interrupted: true }), ROOT, { headCommit: () => head, assumeSuccess: true }))
      .toEqual([{ kind: 'test_run', data: { passed: false, command: 'npm test' } }]);
  });

});

describe('transcripts, excerpts, output', () => {
  it('reads the model of the last main-thread assistant entry of a Claude transcript', () => {
    expect(lastAssistantModel(join(here, 'fixtures/claude/transcript.jsonl'))).toBe('claude-opus-5');
    const dir = mkdtempSync(join(tmpdir(), 'conus-tr-'));
    const p = join(dir, 't.jsonl');
    writeFileSync(p, [
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'a' }] } }),
      JSON.stringify({ type: 'assistant', isSidechain: true, message: { model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'sub' }] } }),
      JSON.stringify({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } }),
      JSON.stringify({ type: 'user', message: { content: 'x' } }),
      '{"type":"assistant","message":{"model":"cut',
    ].join('\n'));
    expect(lastAssistantModel(p)).toBe('claude-opus-5');
    writeFileSync(p, JSON.stringify({ type: 'assistant', message: { model: 'm'.repeat(101), content: [] } }));
    expect(lastAssistantModel(p)).toBeNull();
    expect(lastAssistantModel(join(here, 'fixtures/codex/rollout.jsonl'))).toBeNull();
    expect(lastAssistantModel(join(here, 'fixtures/missing.jsonl'))).toBeNull();
  });
  describe('currentTurnToolCalls: each tool call of the current turn — tool, command, start/end time, toolUseResult', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conus-turn-'));
    const write = (lines: unknown[]) => { const p = join(dir, `t-${Math.random()}.jsonl`); writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n'); return p; };
    // Shapes as recorded: prompts and tool results carry their prompt's promptId; tool_use entries carry the call.
    const prompt = (content: unknown, promptId?: string, extra: Record<string, unknown> = {}) =>
      ({ type: 'user', isSidechain: false, ...(promptId ? { promptId } : {}), ...extra, message: { role: 'user', content } });
    let n = 0;
    const call = (command = 'git commit -m x', at = '2026-10-09T01:28:08.000Z', name = 'Bash') =>
      ({ type: 'assistant', isSidechain: false, timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${++n}`, name, input: { command } }] } });
    const result = (sha: string | null, promptId?: string, at = '2026-10-09T01:28:10.000Z') => ({
      type: 'user', isSidechain: false, timestamp: at, ...(promptId ? { promptId } : {}),
      toolUseResult: sha ? { stdout: '', gitOperation: { commit: { sha, kind: 'committed', branch: 'main' } } } : { stdout: 'nothing to commit' },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${n}`, content: 'x' }] },
    });
    const image = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }];
    const shas = (path: string, promptId: string | null = null, max?: number) =>
      currentTurnToolCalls(path, promptId, max)?.map((c) => commitEvidence(c.result)).filter((e) => e).map((e) => e!.sha) ?? null;

    it('pairs each tool result with its tool_use: tool, command and the call\'s time window', () => {
      const p = write([prompt('go', 'p1'), call('git commit -q -m x', '2026-10-09T01:28:08.125Z'), result(null, 'p1', '2026-10-09T01:28:10.048Z')]);
      expect(currentTurnToolCalls(p, 'p1')).toEqual([{
        name: 'Bash', command: 'git commit -q -m x', startedAt: Date.parse('2026-10-09T01:28:08.125Z'), endedAt: Date.parse('2026-10-09T01:28:10.048Z'),
        result: { stdout: 'nothing to commit' },
      }]);
    });

    it('selects the tool results of the prompt id the Stop payload names (else the newest turn\'s)', () => {
      const p = write([prompt('one', 'p1'), call(), result('aaaa111', 'p1'), prompt('two', 'p2'), call(), result('bbbb222', 'p2'), call(), result(null, 'p2')]);
      expect(shas(p, 'p2')).toEqual(['bbbb222']);
      expect(shas(p, 'p1')).toEqual(['aaaa111']);
      expect(shas(p)).toEqual(['bbbb222']);
      expect(currentTurnToolCalls(p, 'p2')).toHaveLength(2);
    });

    it('an image-only prompt starts its own turn (with and without prompt ids)', () => {
      expect(shas(write([prompt('one', 'p1'), call(), result('aaaa111', 'p1'), prompt(image, 'p2'), call(), result(null, 'p2')]))).toEqual([]);
      expect(shas(write([prompt('one'), call(), result('aaaa111'), prompt(image), call(), result(null)]))).toEqual([]);
    });

    it('a Stop-hook feedback continuation (as recorded: isMeta, the same promptId) stays in the turn', () => {
      const feedback = prompt('Stop hook feedback:\n…', 'p1', { isMeta: true });
      const p = write([prompt('commit it', 'p1'), call(), result('aaaa111', 'p1'), feedback, call(), result('cccc333', 'p1')]);
      expect(shas(p, 'p1')).toEqual(['aaaa111', 'cccc333']);
      expect(shas(p)).toEqual(['aaaa111', 'cccc333']);
      const noIds = write([prompt('commit it'), call(), result('aaaa111'), { ...feedback, promptId: undefined }, call(), result('cccc333')]);
      expect(shas(noIds)).toEqual(['aaaa111', 'cccc333']);
    });

    it('a background-task notification (promptSource "system", its own promptId) starts a turn', () => {
      const note = prompt('<task-notification>…</task-notification>', 'p2', { promptSource: 'system' });
      expect(shas(write([prompt('go', 'p1'), call(), result('aaaa111', 'p1'), note, call(), result(null, 'p2')]))).toEqual([]);
    });

    it('a compact summary inside the turn does not end it', () => {
      const compact = { type: 'user', isSidechain: false, isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'This session is being continued…' } };
      expect(shas(write([prompt('go', 'p1'), call(), result('aaaa111', 'p1'), { ...compact, promptId: 'p9' }, call(), result('bbbb222', 'p1')]))).toEqual(['aaaa111', 'bbbb222']);
      expect(shas(write([prompt('go'), call(), result('aaaa111'), compact, call(), result('bbbb222')]))).toEqual(['aaaa111', 'bbbb222']);
    });

    it('without prompt ids falls back to the last turn start; meta entries are not turn starts; reads a bounded tail', () => {
      const meta = { type: 'user', isMeta: true, message: { role: 'user', content: 'Caveat: local command output' } };
      expect(shas(write([prompt('one'), call(), result('aaaa111'), prompt([{ type: 'text', text: 'two' }]), call(), result('bbbb222'), meta, call(), result('cccc333')])))
        .toEqual(['bbbb222', 'cccc333']);
      const long = write([prompt('a'), call(), result('aaaa111'), prompt('b'), ...Array.from({ length: 50 }, () => call()), call(), result('dddd444')]);
      expect(shas(long, null, 2000)).toEqual(['dddd444']);
      expect(currentTurnToolCalls(join(here, 'fixtures/missing.jsonl'), null)).toBeNull();
    });

    it('subagent entries (sidechain) are never this turn\'s calls (subagents write their own files)', () => {
      expect(shas(write([prompt('go', 'p1'), call(), { ...result('eeee555', 'p1'), isSidechain: true }]), 'p1')).toEqual([]);
    });

    it('the recorded PowerShell turn: the commit call carries gitOperation and its window', () => {
      const calls = currentTurnToolCalls(join(here, 'fixtures/claude/transcript-powershell.jsonl'), 'p-1')!;
      expect(calls.map((c) => [c.name, commitEvidence(c.result)])).toEqual([['PowerShell', { sha: '1cbc0fc', kind: 'committed', branch: 'main' }], ['PowerShell', null]]);
      expect(calls[0]!.endedAt! - calls[0]!.startedAt!).toBeGreaterThan(0);
    });
  });

  it('reads the last assistant text from Claude and Codex transcripts', () => {
    expect(lastAssistantText(join(here, 'fixtures/claude/transcript.jsonl'))).toBe('Готово: импорт добавлен, тесты проходят.');
    expect(lastAssistantText(join(here, 'fixtures/codex/rollout.jsonl'))).toBe('Импорт сделан.');
    expect(lastAssistantText(join(here, 'fixtures/missing.jsonl'))).toBeNull();
  });
  it('excerpts', () => {
    expect(headExcerpt('a'.repeat(3000))!.length).toBe(2000);
    const t = tailExcerpt('x'.repeat(2500) + 'END')!;
    expect(t.length).toBe(2000);
    expect(t.startsWith('…')).toBe(true);
    expect(t.endsWith('END')).toBe(true);
  });
  it('formats per agent', () => {
    expect(formatOutput('claude', 'session-start', { context: 'CTX' })).toBe('CTX');
    expect(JSON.parse(formatOutput('codex', 'session-start', { context: 'CTX' }))).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'CTX' } });
    expect(JSON.parse(formatOutput('claude', 'prompt', { statusLine: 'S' }))).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'S' } });
    expect(JSON.parse(formatOutput('codex', 'stop', { nudge: 'N' }))).toEqual({ decision: 'block', reason: 'N' });
    expect(formatOutput('claude', 'stop', {})).toBe('');
  });
});
