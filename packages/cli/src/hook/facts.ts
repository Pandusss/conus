import { posix } from 'node:path';
import { clamp } from '../clamp';
import { amendedFrom, COMMIT_ACTION_RE, type ReflogEntry } from '../git';
import type { HookInput } from './normalize';

// Re-declared from @conus/core on purpose: conus must not import core.
export type Fact =
  | { kind: 'file_edit'; data: { path: string } }
  | { kind: 'git_commit'; data: { sha: string; subject: string; branch?: string; amends?: string } }
  | { kind: 'test_run'; data: { passed: boolean | null; command: string } }
  | { kind: 'task_op'; data: { tool: string; task?: string } };

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'edit', 'write', 'create_file', 'str_replace_based_edit_tool']);
const PATCH_TOOLS = new Set(['apply_patch', 'ApplyPatch']);
const SHELL_TOOLS = new Set(['Bash', 'shell', 'exec_command', 'local_shell', 'unified_exec']);
// Claude Code's shell tool on Windows (CLAUDE_CODE_USE_POWERSHELL_TOOL=1): `tool_input.command` is a PowerShell script.
const POWERSHELL_TOOLS = new Set(['PowerShell']);
const CONUS_TOOL_RE = /(?:^|__)(tasks_context|task_(?:create|propose|start|update|block|complete|drop))$/;

// Server-side validation limits (packages/server/src/routes/hooks.ts FactSchema). A fact that breaks
// them makes the server reject the whole batch with 400, which the outbox then drops for good.
const MAX_PATH = 500;
const MAX_TASK = 30;
const SHA_RE = /^[0-9a-f]{7,40}$/i;

function conusToolName(name: string): string | null {
  const m = CONUS_TOOL_RE.exec(name);
  if (!m) return null;
  const prefix = name.slice(0, name.length - m[1]!.length);
  return prefix.split('_').includes('conus') ? m[1]! : null;
}

export function isRelevantTool(name: string | null): boolean {
  if (!name) return false;
  return EDIT_TOOLS.has(name) || PATCH_TOOLS.has(name) || SHELL_TOOLS.has(name) || POWERSHELL_TOOLS.has(name) || conusToolName(name) !== null;
}

export function relPath(root: string, file: string): string {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\/([a-zA-Z])\//, (_m, d: string) => `${d.toUpperCase()}:/`).replace(/\/+$/, '');
  const r = norm(root);
  const f = norm(file);
  const winAbs = /^[A-Za-z]:\//.test(f);
  if (!winAbs && !f.startsWith('/')) return f.replace(/^\.\//, '');
  const cmp = (s: string) => (winAbs ? s.toLowerCase() : s);
  return cmp(f).startsWith(cmp(r) + '/') ? f.slice(r.length + 1) : f;
}

/**
 * Where commit detection asks git (reflog, resolve, HEAD, amend): the session's repo root — `state.root`, as
 * `git rev-parse --show-toplevel` gave it at SessionStart — never the hook's cwd: Claude Code reports the shell's cwd,
 * which a `cd` may have moved into another (nested or scratch) repo. On win32 an MSYS drive path (`/c/x`) is read as
 * `C:/x`, as relPath reads the root. The hook cwd only when the state has no root.
 */
export function sessionGitDir(root: string | null | undefined, cwd: string, platform: NodeJS.Platform = process.platform): string {
  if (!root) return cwd;
  return platform === 'win32' ? root.replace(/^\/([a-zA-Z])\//, (_m, d: string) => `${d.toUpperCase()}:/`) : root;
}

/**
 * True when a normalized `relPath` result does not name a file inside the repo: absolute (`/x`,
 * `//server/share`, `C:/x`, `C:x`) or climbing out (`..`, `../x`). Such paths are never reported,
 * so no absolute path leaves the machine.
 */
const outsideRepo = (rel: string) =>
  rel === '.' || rel === '..' || rel.startsWith('../') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel);

/** POSIX `/x`, Windows `C:\x` / `C:/x`, UNC `\\server\share`. */
const isAbsolute = (p: string) => /^(?:[A-Za-z]:)?[\\/]/.test(p);

export function patchFiles(patch: string): string[] {
  const out: string[] = [];
  for (const m of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) {
    const p = m[1]!.trim();
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

const quoteArg = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

export function shellCommand(input: unknown): string | null {
  const c = (input as { command?: unknown } | null)?.command;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.every((x) => typeof x === 'string')) {
    if (c.length >= 3 && /(^|\/)(ba|z)?sh$/.test(c[0]!) && /^-l?c$/.test(c[1]!)) return c.slice(2).join(' ');
    // A direct argv: quote arguments so that e.g. a commit message `fix && npm test` stays one word.
    return c.map(quoteArg).join(' ');
  }
  return null;
}

const LEADING_EXIT_RE = /^\s*exit code:?\s*(-?\d+)/i;
const leadingExitCode = (s: string): number | null => {
  const m = LEADING_EXIT_RE.exec(s);
  return m ? Number(m[1]) : null;
};

/**
 * Exit code of a shell tool call. Codex reports `Exit code: N` as the first line of a string result (or
 * of its `output` field); command output itself (Claude `stdout`, later lines) is never scanned, because
 * it can mention "exit code: 1" for any reason.
 */
export function exitCodeOf(resp: unknown): number | null {
  if (resp == null) return null;
  if (typeof resp === 'string') return leadingExitCode(resp);
  if (typeof resp === 'object') {
    const r = resp as Record<string, unknown>;
    for (const k of ['exit_code', 'exitCode', 'returncode', 'code']) if (typeof r[k] === 'number') return r[k] as number;
    if (r.is_error === true || r.isError === true || r.interrupted === true) return 1;
    if (typeof r.output === 'string') return leadingExitCode(r.output);
  }
  return null;
}

// --- shell scripts --------------------------------------------------------------------------------

const PATCH_BLOCK_RE = /\*\*\* Begin Patch[\s\S]*?(?:\*\*\* End Patch|$)/g;
// Where bash and this scanner may disagree about what is a command: any heredoc operator (`<<` not part
// of `<<<`, quoted or not), ANSI-C `$'…'` quoting, backslash-newline continuations. A script containing
// one never yields script text (no test_run command); commit detection is unaffected.
const UNSAFE_SCRIPT_RE = /(?<!<)<<(?!<)|\$'|\\\r?\n/;
// Delimiter after `<<`: optional `-`, blanks, then `EOF`, `'EOF'`, `"EOF"` or `\EOF` ending at a word boundary.
const HEREDOC_DELIM_RE = /^(-?)[ \t]*\\?(['"]?)([A-Za-z_][\w.-]*)\2(?=$|[\s;&|()<>])/;

interface Word { value: string; start: number; end: number }

/**
 * Splits a script into simple commands on unquoted newlines, `&&`, `||`, `;`, `|`, `&` and parentheses.
 * Quotes and backslashes are honoured (a quoted `a && b` stays one word); `#` comments are skipped;
 * redirections such as `2>&1` and `&>file` stay words; each word keeps its offsets in `script`.
 * Heredoc bodies are skipped. Fails closed, because heredoc bodies are file contents:
 * - an unquoted `<<` (not `<<<`) whose delimiter is not recognised ends the scan at the end of its line;
 * - a `<<` inside a quoted string, or unbalanced quotes, set `unsafeQuoting`: the caller must not send
 *   any script text then.
 */
function scanScript(script: string): { commands: Word[][]; unsafeQuoting: boolean } {
  const commands: Word[][] = [];
  let words: Word[] = [];
  let cur: Word | null = null;
  let quote: string | null = null;
  let unsafeQuoting = false;
  let limit = script.length;
  const pending: { delim: string; dash: boolean }[] = [];
  const add = (i: number, s: string) => { (cur ??= { value: '', start: i, end: i }).value += s; };
  const endWord = (i: number) => { if (cur) { cur.end = i; words.push(cur); cur = null; } };
  const endCmd = (i: number) => { endWord(i); if (words.length) commands.push(words); words = []; };
  // Skips the bodies of the pending heredocs, which start after the newline at `nl`. Returns the index
  // of the last consumed character; an unterminated heredoc swallows the rest of the script.
  const skipBodies = (nl: number): number => {
    let pos = nl + 1;
    while (pending.length && pos < script.length) {
      const end = script.indexOf('\n', pos);
      const lineEnd = end < 0 ? script.length : end;
      const line = script.slice(pos, lineEnd).replace(/\r$/, '');
      const { delim, dash } = pending[0]!;
      if ((dash ? line.replace(/^\t+/, '') : line) === delim) pending.shift();
      pos = lineEnd + 1;
    }
    if (pending.length) { pending.length = 0; return script.length; }
    return Math.min(pos - 1, script.length);
  };
  for (let i = 0; i < limit; i++) {
    const ch = script[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else {
        if (ch === '<' && script[i + 1] === '<') unsafeQuoting = true;
        if (ch === '\\' && quote === '"' && i + 1 < limit) add(i, script[++i]!);
        else add(i, ch);
      }
    } else if (ch === "'" || ch === '"') {
      add(i, '');
      quote = ch;
    } else if (ch === '\\') {
      if (script[i + 1] === '\n') i++;
      else if (i + 1 < limit) add(i, script[++i]!);
    } else if (ch === '#' && !cur) {
      while (i + 1 < limit && script[i + 1] !== '\n') i++;
    } else if (ch === '<' && script[i + 1] === '<') {
      if (script[i + 2] === '<') { // here-string `<<<`: just a word
        add(i, '<<<');
        i += 2;
        continue;
      }
      const m = HEREDOC_DELIM_RE.exec(script.slice(i + 2, limit));
      if (m) {
        pending.push({ delim: m[3]!, dash: m[1] === '-' });
        add(i, '<<' + m[0]);
        i += 1 + m[0].length;
      } else {
        // Unknown delimiter: its body cannot be found, so nothing after this line is looked at.
        const nl = script.indexOf('\n', i);
        limit = nl < 0 ? script.length : nl;
        add(i, '<<');
        i++;
      }
    } else if (ch === '&' && (script[i - 1] === '>' || script[i - 1] === '<' || script[i + 1] === '>')) {
      add(i, ch);
    } else if (ch === '\n') {
      endCmd(i);
      if (pending.length) i = skipBodies(i);
    } else if (';|&()'.includes(ch)) {
      endCmd(i);
    } else if (/\s/.test(ch)) {
      endWord(i);
    } else {
      add(i, ch);
    }
  }
  if (quote) unsafeQuoting = true;
  endCmd(limit);
  return { commands, unsafeQuoting };
}

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELL_PREFIXES = new Set(['{', '!', 'then', 'do', 'else', 'time', 'exec', 'command', 'env']);
const TEST_SCRIPT_RE = /^test(?::[\w:.-]*)?$/;
const TEST_BINS = new Set(['vitest', 'jest', 'pytest']);
const bin = (w: string | undefined) => (w ?? '').replace(/^.*[\\/]/, '').replace(/\.(?:cmd|exe|bat)$/i, '').toLowerCase();

/** `words` starts at the command word (assignments and shell keywords already skipped). */
function isTestRun(words: string[]): boolean {
  let w = words;
  if (bin(w[0]) === 'npx' || bin(w[0]) === 'bunx') {
    w = w.slice(1);
    while (w[0]?.startsWith('-')) w = w.slice(1);
  } else if (bin(w[0]) === 'pnpm' && (w[1] === 'exec' || w[1] === 'dlx')) {
    w = w.slice(2);
  }
  const cmd = bin(w[0]);
  const args = w.slice(1).filter((a) => !a.startsWith('-'));
  if (TEST_BINS.has(cmd)) return true;
  switch (cmd) {
    case 'npm': case 'pnpm': case 'yarn': case 'bun':
      if (TEST_SCRIPT_RE.test(args[0] ?? '') || (cmd === 'npm' && args[0] === 't')) return true;
      if ((args[0] === 'run' || args[0] === 'run-script') && TEST_SCRIPT_RE.test(args[1] ?? '')) return true;
      return (cmd === 'yarn' || cmd === 'pnpm') && TEST_BINS.has(bin(args[0]));
    case 'go': case 'cargo': case 'dotnet': case 'deno':
      return args[0] === 'test';
    case 'gradle': case 'gradlew': case 'mvn': case 'mvnw':
      return args.some((a) => a === 'test' || a.endsWith(':test'));
    case 'node':
      return w.includes('--test');
    case 'python': case 'python3': case 'py':
      return w[1] === '-m' && w[2] === 'pytest';
    default:
      return false;
  }
}

/** Index of the `commit` subcommand in a `git … commit …` command, or -1. */
function gitCommitIndex(words: string[]): number {
  if (bin(words[0]) !== 'git') return -1;
  let i = 1;
  while (i < words.length && words[i]!.startsWith('-')) i += words[i] === '-C' || words[i] === '-c' ? 2 : 1;
  return words[i] === 'commit' ? i : -1;
}
const isGitCommit = (words: string[]) => gitCommitIndex(words) >= 0;

/**
 * Finds a test run and a `git commit` among the script's simple commands (command position only, never
 * inside a heredoc, a patch, a quoted message or an argument). `testCommand` is only the matched simple
 * command, from its command word on (leading `VAR=val` assignments dropped), at most 300 chars.
 * Fails closed: no `testCommand` (script text) when the raw script carries a patch, unbalanced quotes,
 * or anything bash may read differently from this scanner (UNSAFE_SCRIPT_RE). A commit is still
 * reported, since only git's sha and subject are sent for it.
 */
export function analyzeShellScript(script: string): { testCommand: string | null; commit: boolean } {
  const clean = script.replace(PATCH_BLOCK_RE, '');
  const { commands, unsafeQuoting } = scanScript(clean);
  const mayQuote = !script.includes('*** Begin Patch') && !unsafeQuoting && !UNSAFE_SCRIPT_RE.test(script);
  let testCommand: string | null = null;
  let commit = false;
  for (const cmd of commands) {
    let start = 0;
    while (start < cmd.length && (ASSIGNMENT_RE.test(cmd[start]!.value) || SHELL_PREFIXES.has(cmd[start]!.value))) start++;
    const words = cmd.slice(start).map((w) => w.value);
    if (!words.length) continue;
    if (isGitCommit(words)) commit = true;
    if (mayQuote && testCommand === null && isTestRun(words)) testCommand = clamp(clean.slice(cmd[start]!.start, cmd.at(-1)!.end), 300);
  }
  return { testCommand, commit };
}

// --- PowerShell scripts (Claude Code's PowerShell tool on Windows) ------------------------------------

/**
 * Splits a PowerShell script into simple commands on unquoted `;`, newlines, `|`, `&&`, `||`, `&` (the call
 * operator, or a background job), parentheses and braces (`if ($?) { git commit … }`). `'…'` (with `''`) and `"…"`
 * (with backtick escapes and `""`) keep a word together; `#` and `<# … #>` comments are skipped; a here-string
 * (`@'…'@`, `@"…"@`) is one word whose body is never scanned for commands; redirections like `2>&1` stay words.
 * `unsafe`: a here-string, a backtick line continuation or unbalanced quotes — the caller must not send script text.
 */
function scanPowerShell(script: string): { commands: Word[][]; unsafe: boolean } {
  const commands: Word[][] = [];
  let words: Word[] = [];
  let cur: Word | null = null;
  let quote: string | null = null;
  let unsafe = false;
  const add = (i: number, s: string) => { (cur ??= { value: '', start: i, end: i }).value += s; };
  const endWord = (i: number) => { if (cur) { cur.end = i; words.push(cur); cur = null; } };
  const endCmd = (i: number) => { endWord(i); if (words.length) commands.push(words); words = []; };
  for (let i = 0; i < script.length; i++) {
    const ch = script[i]!;
    if (quote === "'") {
      if (ch !== "'") add(i, ch);
      else if (script[i + 1] === "'") add(i++, "'");
      else quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === '`' && i + 1 < script.length) add(i, script[++i]!);
      else if (ch !== '"') add(i, ch);
      else if (script[i + 1] === '"') add(i++, '"');
      else quote = null;
      continue;
    }
    if (ch === '@' && (script[i + 1] === "'" || script[i + 1] === '"')) {
      const q = script[i + 1]!;
      const open = /^[ \t]*\r?\n/.exec(script.slice(i + 2));
      if (open) {
        // A here-string ends at a line starting with '@ (or "@); unterminated, it swallows the rest.
        unsafe = true;
        const body = i + 2 + open[0].length;
        const close = script.startsWith(q + '@', body) ? body : script.indexOf(`\n${q}@`, body - 1) + 1;
        add(i, '@here-string');
        i = close > 0 ? close + 1 : script.length;
        continue;
      }
    }
    if (ch === "'" || ch === '"') {
      add(i, '');
      quote = ch;
    } else if (ch === '`') {
      const next = script[i + 1] === '\r' && script[i + 2] === '\n' ? 2 : script[i + 1] === '\n' ? 1 : 0;
      if (next) { unsafe = true; i += next; } // line continuation
      else if (i + 1 < script.length) add(i, script[++i]!);
    } else if (ch === '<' && script[i + 1] === '#') {
      endWord(i);
      const end = script.indexOf('#>', i + 2);
      i = end < 0 ? script.length : end + 1;
    } else if (ch === '#' && !cur) {
      while (i + 1 < script.length && script[i + 1] !== '\n') i++;
    } else if (ch === '&' && (script[i - 1] === '>' || script[i + 1] === '>')) {
      add(i, ch);
    } else if (ch === '\n' || ch === '\r' || ';|&(){}'.includes(ch)) {
      endCmd(i);
    } else if (/\s/.test(ch)) {
      endWord(i);
    } else {
      add(i, ch);
    }
  }
  if (quote) unsafe = true;
  endCmd(script.length);
  return { commands, unsafe };
}

/** powershell.exe / pwsh `-EncodedCommand` and its abbreviations (`-e`, `-enc`, …, `-ec`): the script text is opaque. */
const isEncodedCommandFlag = (w: string) => {
  const lower = w.toLowerCase();
  return lower === '-ec' || (lower.length >= 2 && '-encodedcommand'.startsWith(lower));
};

/**
 * analyzeShellScript for PowerShell: a test run and a `git commit` among the simple commands, at command position
 * (after a `$var =` assignment too), with the same runner rules. Fails closed — no `testCommand` — on a
 * here-string, a backtick line continuation, unbalanced quotes or `-EncodedCommand`. A commit is still reported:
 * only git's sha and subject are sent for it.
 */
export function analyzePowerShellScript(script: string): { testCommand: string | null; commit: boolean } {
  const { commands, unsafe } = scanPowerShell(script);
  const mayQuote = !unsafe && !commands.some((c) => c.some((w) => isEncodedCommandFlag(w.value)));
  let testCommand: string | null = null;
  let commit = false;
  for (const cmd of commands) {
    const start = cmd.length > 2 && /^\$[\w:]+$/.test(cmd[0]!.value) && cmd[1]!.value === '=' ? 2 : 0;
    const words = cmd.slice(start).map((w) => w.value);
    if (!words.length) continue;
    if (isGitCommit(words)) commit = true;
    if (mayQuote && testCommand === null && isTestRun(words)) testCommand = clamp(script.slice(cmd[start]!.start, cmd.at(-1)!.end), 300);
  }
  return { testCommand, commit };
}

/**
 * Caps the facts of one post at `max`, dropping file edits beyond it but never a git_commit, test_run or
 * task_op (a dropped git_commit would be lost for good: its HEAD is recorded as seen once posted).
 */
export function capFacts(facts: Fact[], max: number): Fact[] {
  if (facts.length <= max) return facts;
  let fileBudget = max - facts.filter((f) => f.kind !== 'file_edit').length;
  return facts.filter((f) => f.kind !== 'file_edit' || fileBudget-- > 0).slice(0, max);
}

/** A directory as a repo-relative path with forward slashes: `.` for the root itself or anything outside it. */
export function repoRelativeDir(root: string, dir: string): string {
  const rel = posix.normalize(relPath(root, dir));
  return outsideRepo(rel) ? '.' : rel;
}

/**
 * Files a Claude Code Bash call changed, from `tool_response.bashEditDiff` (recorded from 2.1.270:
 * `changedFiles: string[]`, plus `files: [{filePath, hunks}]`). Paths only.
 */
function bashChangedFiles(resp: unknown): string[] {
  const d = (resp as { bashEditDiff?: unknown } | null)?.bashEditDiff as { changedFiles?: unknown; files?: unknown } | undefined;
  if (!d || typeof d !== 'object') return [];
  const list = Array.isArray(d.changedFiles) ? d.changedFiles : Array.isArray(d.files) ? d.files.map((f) => (f as { filePath?: unknown } | null)?.filePath) : [];
  return list.filter((p): p is string => typeof p === 'string' && p.length > 0);
}

/** Claude Code's own record of a commit one of its tool calls made. */
export interface CommitEvidence { sha: string; kind: string | null; branch: string | null }

/**
 * `gitOperation.commit` of a Claude Code tool response (PostToolUse `tool_response`, or a transcript tool result's
 * `toolUseResult`), for Bash and PowerShell: `{sha (7 chars), kind: "committed" | "amended", branch}`. Claude Code reads
 * it from git's `[branch sha]` output line, so there is none for `git commit -q`, and the sha may be another repo's
 * (`git -C other commit`). Null when there is none, or the sha is not a hex sha.
 */
export function commitEvidence(resp: unknown): CommitEvidence | null {
  const c = ((resp as { gitOperation?: unknown } | null)?.gitOperation as { commit?: unknown } | undefined)?.commit as
    { sha?: unknown; kind?: unknown; branch?: unknown } | undefined;
  if (!c || typeof c !== 'object' || typeof c.sha !== 'string' || !/^[0-9a-f]{4,40}$/i.test(c.sha)) return null;
  return { sha: c.sha, kind: typeof c.kind === 'string' ? c.kind : null, branch: typeof c.branch === 'string' && c.branch ? c.branch : null };
}

type GitCommitData = Extract<Fact, { kind: 'git_commit' }>['data'];

/**
 * The commits of THIS repo that one Claude Code shell call made, oldest first. A commit counts only when it is a commit
 * of this repo and either (i) Claude Code's record names it (`evidence`, resolved in this repo: from `repo.reflog`, or
 * by `repo.resolve` — another repo's sha, a git error or a timeout drops it), or (ii) the call ran `git … commit` at
 * command position (`ranCommit`) and its reflog entry is a commit (`commit…:`) made inside the call's `window` —
 * how a quiet `git commit -q` (no record) is found; several commits of one call are all found. `amends` = HEAD@{1}
 * only while that commit is the reflog top's `commit (amend)`. The branch comes from the record only.
 */
export function claudeCallCommits(
  call: { evidence: CommitEvidence | null; ranCommit: boolean; window: { from: number; to: number } | null },
  repo: { reflog: ReflogEntry[] | null; resolve: (sha: string) => { sha: string; subject: string } | null },
): GitCommitData[] {
  const out: GitCommitData[] = [];
  const add = (sha: string, subject: string, branch: string | null) => {
    if (out.some((c) => c.sha.toLowerCase() === sha.toLowerCase())) return;
    const amends = amendedFrom(repo.reflog, sha);
    out.push({ sha, subject, ...(branch ? { branch } : {}), ...(amends ? { amends } : {}) });
  };
  const ev = call.evidence;
  const named = (sha: string) => !!ev && sha.toLowerCase().startsWith(ev.sha.toLowerCase());
  if (call.ranCommit && call.window) {
    for (const e of [...(repo.reflog ?? [])].reverse()) {
      if (COMMIT_ACTION_RE.test(e.action) && e.time >= call.window.from && e.time <= call.window.to) add(e.sha, e.subject, named(e.sha) ? ev!.branch : null);
    }
  }
  if (ev) {
    const hit = repo.reflog?.find((e) => named(e.sha));
    const r = hit ? { sha: hit.sha, subject: hit.subject } : repo.resolve(ev.sha);
    if (r) add(r.sha, r.subject, ev.branch);
  }
  return out;
}

/** Whether a shell tool call (Bash-like or PowerShell) runs `git … commit` at command position. */
export function runsGitCommit(tool: string, command: string): boolean {
  if (POWERSHELL_TOOLS.has(tool)) return analyzePowerShellScript(command).commit;
  if (SHELL_TOOLS.has(tool)) return analyzeShellScript(command).commit;
  return false;
}

export function extractFacts(
  input: HookInput, root: string,
  deps: {
    assumeSuccess: boolean;
    /**
     * Where a commit comes from. 'claude' (Claude Code): `claudeCommits` for a call with a commit record or a
     * `git … commit` command (see claudeCallCommits) — whatever its exit code, HEAD is never read. 'head' (Codex, the
     * default: it records nothing): a `git commit` command that exited 0, and the new HEAD from `headCommit` — read in
     * the session's repo root (sessionGitDir), so it is a commit of this repo by construction.
     */
    commits?: 'claude' | 'head';
    claudeCommits?: (call: { evidence: CommitEvidence | null; ranCommit: boolean }) => GitCommitData[];
    headCommit: () => { sha: string; subject: string } | null;
    /**
     * The commit `sha` replaced, when the reflog says it was created by `commit (amend)` (HEAD@{1}); null otherwise.
     * The reflog is the only source: neither the command line nor a saved HEAD (which can be stale and name a commit
     * that is still in history) decides it.
     */
    amends?: (sha: string) => string | null;
  },
): Fact[] {
  const name = input.toolName ?? '';
  const ti = (input.toolInput ?? {}) as Record<string, unknown>;
  const facts: Fact[] = [];
  // Relative tool paths (Codex apply_patch) are relative to the session cwd, which may be a repo subdirectory.
  const cwd = input.cwd.replace(/[\\/]+$/, '');
  const pushFile = (p: string) => {
    const rel = relPath(root, isAbsolute(p) ? p : `${cwd}/${p}`);
    if (!rel) return;
    const path = posix.normalize(rel); // `packages/cli/../core/x.ts` → `packages/core/x.ts`, `src/../../x` → `../x`
    if (path.length > MAX_PATH || outsideRepo(path)) return;
    if (!facts.some((f) => f.kind === 'file_edit' && f.data.path === path)) facts.push({ kind: 'file_edit', data: { path } });
  };
  if (EDIT_TOOLS.has(name)) {
    const p = ti.file_path ?? ti.notebook_path ?? ti.path;
    if (typeof p === 'string') pushFile(p);
  } else if (PATCH_TOOLS.has(name)) {
    const patch = typeof input.toolInput === 'string' ? input.toolInput : String(ti.input ?? ti.patch ?? '');
    patchFiles(patch).forEach(pushFile);
  } else if (SHELL_TOOLS.has(name) || POWERSHELL_TOOLS.has(name)) {
    const cmd = shellCommand(ti);
    // Claude Code reports what a Bash command changed: only the paths are used, never the hunks.
    bashChangedFiles(input.toolResponse).forEach(pushFile);
    const evidence = commitEvidence(input.toolResponse);
    const { testCommand, commit } = cmd ? (POWERSHELL_TOOLS.has(name) ? analyzePowerShellScript : analyzeShellScript)(cmd) : { testCommand: null, commit: false };
    if (deps.commits === 'claude' && (evidence || commit)) {
      for (const data of deps.claudeCommits?.({ evidence, ranCommit: commit }) ?? []) facts.push({ kind: 'git_commit', data });
    }
    if (cmd) {
      if (cmd.includes('*** Begin Patch')) patchFiles(cmd).forEach(pushFile);
      const code = exitCodeOf(input.toolResponse);
      if (deps.commits !== 'claude' && (commit || evidence) && (code === null || code === 0)) {
        const h = deps.headCommit();
        if (h && SHA_RE.test(h.sha)) {
          // An amend replaces the previous HEAD: the server swaps that commit's task link for this one.
          const prev = deps.amends?.(h.sha) ?? null;
          const amends = prev && SHA_RE.test(prev) && prev.toLowerCase() !== h.sha.toLowerCase() ? prev : null;
          facts.push({ kind: 'git_commit', data: amends ? { sha: h.sha, subject: h.subject, amends } : { sha: h.sha, subject: h.subject } });
        }
      }
      if (testCommand) {
        const passed = code === null ? (deps.assumeSuccess ? true : null) : code === 0;
        facts.push({ kind: 'test_run', data: { passed, command: testCommand } });
      }
    }
  } else {
    const tool = conusToolName(name);
    if (tool) {
      const task = typeof ti.task === 'string' && ti.task.length > 0 && ti.task.length <= MAX_TASK ? ti.task : null;
      facts.push({ kind: 'task_op', data: task ? { tool, task } : { tool } });
    }
  }
  return facts;
}
