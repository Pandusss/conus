import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApi, type Api } from '../api-client';
import { configDir, readConfig } from '../config';
import { isRepoDisabled } from '../disable';
import { writeFileAtomic } from '../fsutil';
import {
  amendedFrom, headCommit as gitHead, reflog as gitReflog, repoContext as gitRepo, resolveCommit as gitResolveCommit,
  type ReflogEntry, type RepoContext,
} from '../git';
import { log } from '../log';
import { enqueue, flushOutbox, isPermanentRejection } from '../outbox';
import { loadState, removeState, saveState } from '../state';
import { activityBody, endBody, MAX_STOP_COMMITS, promptBody, startBody, stopBody } from './bodies';
import { capFacts, claudeCallCommits, commitEvidence, extractFacts, isRelevantTool, repoRelativeDir, runsGitCommit, sessionGitDir, type Fact } from './facts';
import { formatOutput } from './output';
import { normalizeHookInput, type AgentFlavor, type HookEvent } from './normalize';
import { currentTurnToolCalls, lastAssistantModel, lastAssistantText } from './transcript';

export interface HookDeps {
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
  git: {
    repoContext(cwd: string): RepoContext | null;
    headCommit(cwd: string): { sha: string; subject: string } | null;
    reflog(cwd: string, timeoutMs?: number): ReflogEntry[] | null;
    resolveCommit(cwd: string, sha: string, timeoutMs?: number): { sha: string; subject: string } | null;
  };
}


export const STALE_PREFIX =
  '[conus: the task server is unreachable — below is the last saved snapshot, it may be out of date. Conus calls may fail; continue your main work.]\n';

/** Server limit on facts per /activity post (ActivityBody in packages/server/src/routes/hooks.ts). */
export const MAX_FACTS_PER_POST = 200;

/**
 * Time a hook may spend on the network (Global Constraints: session/start 3 s, turn/prompt 1 s, activity 2 s,
 * turn/stop 5 s, session/end 1 s). The outbox flush at the start takes at most half of it, and never more than 1 s
 * (spec §7.2); the hook's own request gets what is left. Stop is the exception: its request keeps the whole 5 s (the
 * server's judge alone may take 4 s), and the flush and git checks before it share a separate STOP_PREWORK_MS.
 */
export const HOOK_BUDGET_MS: Record<HookEvent, number> = { 'session-start': 3000, prompt: 1000, tool: 2000, stop: 5000, 'session-end': 1000 };
export const STOP_PREWORK_MS = 1000;
const flushBudget = (event: HookEvent) => (event === 'stop' ? STOP_PREWORK_MS / 2 : Math.min(1000, HOOK_BUDGET_MS[event] / 2));
/** Everything a hook may spend waiting (the agent-side hook timeouts must cover it plus process start). */
export const hookTotalBudgetMs = (event: HookEvent) => (event === 'stop' ? STOP_PREWORK_MS + HOOK_BUDGET_MS.stop : HOOK_BUDGET_MS[event]);
/** Floor for the hook's own request when the flush and local work used up the budget. */
const MIN_REQUEST_MS = 200;

const START_PATH = '/api/hooks/session/start';

/**
 * The cached snapshot is served when session/start failed, so the server has not (yet) given this session a ref:
 * the old session's ref must not be reused. Drops the `session="…"` attribute and the ref of a status line; the agent
 * then passes `project` (spec §6).
 */
export function withoutSessionRef(context: string): string {
  return context.replace(/(<task-manager)\s+session="[^"]*"/g, '$1').replace(/\[conus S-\w+ · /g, '[conus ');
}

const BOM = '\uFEFF';

const sameSha = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Slack around a shell call's window when matching reflog times (git records whole seconds; clocks and writes lag). */
const COMMIT_WINDOW_SLACK_MS = 2000;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Posts an event; on failure queues it in the outbox, except for a permanent 4xx rejection (the same
 * payload would be rejected again). Returns true when the event was posted or queued. Never throws.
 */
async function deliver(api: Api, outbox: string, dir: string, path: string, body: unknown, timeoutMs: number, what: string): Promise<boolean> {
  try {
    await api.post(path, body, timeoutMs);
    return true;
  } catch (e) {
    if (isPermanentRejection(e)) {
      log(dir, `${what} rejected, dropped: ${message(e)}`);
      return false;
    }
    try {
      enqueue(outbox, path, body);
      log(dir, `${what} queued: ${message(e)}`);
      return true;
    } catch (qe) {
      log(dir, `${what} lost, queueing failed: ${message(qe)}`);
      return false;
    }
  }
}

/**
 * Runs one agent hook event and returns what must be printed to stdout. Fail-open: never throws, and
 * every network call is bounded by the event's timeout (spec §7.2); on any failure the result is ''
 * (session-start falls back to the cached snapshot prefixed with STALE_PREFIX).
 */
export async function runHook(agent: AgentFlavor, event: HookEvent, stdin: string, partial: Partial<Omit<HookDeps, 'git'>> & { git?: Partial<HookDeps['git']> } = {}): Promise<string> {
  let dir: string | null = null;
  try {
    const deps: HookDeps = {
      env: partial.env ?? process.env,
      fetchImpl: partial.fetchImpl ?? fetch,
      git: {
        repoContext: (cwd) => gitRepo(cwd), headCommit: (cwd) => gitHead(cwd),
        reflog: (cwd, t) => gitReflog(cwd, undefined, t),
        resolveCommit: (cwd, sha, t) => gitResolveCommit(cwd, sha, undefined, t),
        ...partial.git,
      },
    };
    dir = configDir(deps.env);
    const logDir = dir;

    // Debug/acceptance aid: keep the raw payload exactly as the agent sent it. Payloads hold prompt text,
    // the assistant's last message and Bash diff hunks (file contents), so files are owner-only (0o600)
    // and the directory must never be committed (`.records/` is git-ignored).
    const rec = deps.env.CONUS_HOOK_RECORD_DIR;
    if (rec) {
      try {
        mkdirSync(rec, { recursive: true });
        writeFileSync(join(rec, `${agent}-${event}-${Date.now()}-${randomBytes(3).toString('hex')}.json`), stdin, { mode: 0o600 });
      } catch { /* never break the hook */ }
    }

    let raw: unknown;
    try {
      raw = JSON.parse(stdin.startsWith(BOM) ? stdin.slice(1) : stdin);
    } catch {
      // Never log the parser's message: it quotes the payload.
      log(logDir, `${agent} ${event}: stdin is not valid JSON`);
      return '';
    }
    const input = normalizeHookInput(agent, raw);
    if (!input) return '';
    const cfg = readConfig(deps.env);
    if (!cfg) return '';
    const api = createApi(cfg, deps.fetchImpl);
    const outbox = join(logDir, 'outbox');
    // Queued events go first, oldest first, before this hook's own request (spec §7.2), within a bounded budget.
    const startedAt = Date.now();
    const deadline = startedAt + HOOK_BUDGET_MS[event];
    const left = (max: number) => Math.min(max, Math.max(MIN_REQUEST_MS, deadline - Date.now()));
    await flushOutbox(outbox, api, flushBudget(event)).catch(() => undefined);

    if (event === 'session-start') {
      const repo = deps.git.repoContext(input.cwd);
      if (!repo || isRepoDisabled(repo.root)) return '';
      try {
        saveState(logDir, input.sessionId, { root: repo.root, head: repo.head, remote: repo.remote, disabled: false });
      } catch (e) {
        log(logDir, `session state not saved: ${message(e)}`);
      }
      const cacheFile = join(logDir, 'cache', sha(repo.remote ?? repo.root).slice(0, 16) + '.md');
      const body = startBody(input, repo, repoRelativeDir(repo.root, input.cwd));
      try {
        const r = await api.post<{ context: string }>(START_PATH, body, left(3000));
        const context = r?.context ?? '';
        if (context) {
          try {
            mkdirSync(join(logDir, 'cache'), { recursive: true });
            writeFileAtomic(cacheFile, context);
          } catch (e) { log(logDir, `context cache write failed: ${message(e)}`); }
        }
        return formatOutput(agent, event, { context });
      } catch (e) {
        log(logDir, `session-start failed: ${message(e)}`);
        // The start is an idempotent upsert: queued (timeout, network, 5xx, 429, …), it registers the session on a
        // later hook's flush, ahead of the session's queued activity. A payload the server rejects is not retried.
        if (!isPermanentRejection(e)) {
          try {
            enqueue(outbox, START_PATH, body);
            log(logDir, 'session-start queued');
          } catch (qe) { log(logDir, `session-start lost, queueing failed: ${message(qe)}`); }
        }
        let cached: string | null = null;
        try { cached = readFileSync(cacheFile, 'utf8'); } catch { cached = null; }
        return cached ? formatOutput(agent, event, { context: STALE_PREFIX + withoutSessionRef(cached) }) : '';
      }
    }

    const state = loadState(logDir, input.sessionId);
    if (!state || state.disabled) return '';
    // Commit detection asks git in the session's repo root, never in the shell's cwd (a `cd` may have left the repo).
    const repoDir = sessionGitDir(state.root, input.cwd);

    if (event === 'prompt') {
      const r = await api.post<{ status_line: string }>('/api/hooks/turn/prompt', promptBody(input, cfg.sendText), left(1000)).catch((e) => { log(logDir, `prompt failed: ${message(e)}`); return null; });
      return formatOutput(agent, event, { statusLine: r?.status_line ?? null });
    }

    if (event === 'tool') {
      if (!isRelevantTool(input.toolName)) return '';
      const seen: { head: string | null } = { head: null };
      let facts = extractFacts(input, state.root, {
        assumeSuccess: agent === 'claude',
        // Claude: commits of this repo named by its record (gitOperation), or found in the reflog inside this call's
        // window (now − duration_ms − slack .. now) when the call ran `git commit` (a quiet `-q` commit has no record).
        // Codex records nothing: a `git commit` command and the new HEAD of this repo. Every git call goes to repoDir.
        commits: agent === 'claude' ? 'claude' : 'head',
        claudeCommits: (call) => claudeCallCommits(
          { ...call, window: input.toolDurationMs === null ? null : { from: startedAt - input.toolDurationMs - COMMIT_WINDOW_SLACK_MS, to: Date.now() } },
          { reflog: deps.git.reflog(repoDir), resolve: (commitSha) => deps.git.resolveCommit(repoDir, commitSha) },
        ),
        amends: (commitSha) => amendedFrom(deps.git.reflog(repoDir), commitSha),
        headCommit: () => {
          const h = deps.git.headCommit(repoDir);
          if (!h || h.sha === state.head) return null;
          seen.head = h.sha;
          return h;
        },
      });
      if (!facts.length) return '';
      if (facts.length > MAX_FACTS_PER_POST) {
        log(logDir, `tool ${input.toolName}: ${facts.length} facts, truncated to ${MAX_FACTS_PER_POST} (file edits dropped)`);
        facts = capFacts(facts, MAX_FACTS_PER_POST);
      }
      const body = activityBody(input, facts, sha(`${input.sessionId}:${Date.now()}:${JSON.stringify(facts)}`).slice(0, 40));
      const delivered = await deliver(api, outbox, logDir, '/api/hooks/activity', body, left(2000), 'activity');
      // HEAD is recorded only once its commit fact is on its way; otherwise the next commit command reports it.
      if (delivered && seen.head) {
        try { saveState(logDir, input.sessionId, { ...state, head: seen.head }); } catch (e) { log(logDir, `session state not saved: ${message(e)}`); }
      }
      return '';
    }

    if (event === 'stop') {
      const answer = cfg.sendText
        ? input.lastAssistantMessage ?? (input.transcriptPath ? lastAssistantText(input.transcriptPath) : null)
        : null;
      // Claude Code's SessionStart carries no model: report it from the transcript (not private text).
      const model = input.model ?? (input.transcriptPath ? lastAssistantModel(input.transcriptPath) : null);
      // The async PostToolUse of a commit may land after this check (or never), so the commits go with the stop too:
      // for each shell call of this turn (the turn delimited by promptId), the commits of this repo it made — named by
      // Claude Code's record (toolUseResult.gitOperation) or, when the call ran `git commit`, found in the reflog
      // between its tool_use and tool_result times (± slack). Codex records none (no Stop-time fact; its PostToolUse
      // path stays). The server links each commit once per session. git is asked in repoDir only.
      const commits: Extract<Fact, { kind: 'git_commit' }>['data'][] = [];
      let observed: string | null = null;
      try {
        const deadline = startedAt + STOP_PREWORK_MS;
        const remaining = () => deadline - Date.now();
        if (remaining() >= 100) {
          const log = deps.git.reflog(repoDir, remaining());
          observed = log?.[0]?.sha ?? null;
          const calls = agent === 'claude' && input.transcriptPath ? currentTurnToolCalls(input.transcriptPath, input.promptId) ?? [] : [];
          const perCall: (typeof commits)[] = [];
          // Newest call first: when the time runs out, the oldest calls are the ones left out.
          for (const call of [...calls].reverse()) {
            const evidence = commitEvidence(call.result);
            const ranCommit = call.name !== null && call.command !== null && runsGitCommit(call.name, call.command);
            if (!evidence && !ranCommit) continue;
            if (remaining() < 100) break;
            const window = call.startedAt !== null && call.endedAt !== null
              ? { from: call.startedAt - COMMIT_WINDOW_SLACK_MS, to: call.endedAt + COMMIT_WINDOW_SLACK_MS } : null;
            perCall.unshift(claudeCallCommits({ evidence, ranCommit, window }, { reflog: log, resolve: (sha) => deps.git.resolveCommit(repoDir, sha, remaining()) }));
          }
          for (const c of perCall.flat()) {
            // Windows of quick successive calls overlap: a commit seen again keeps the branch its own record gives.
            const seen = commits.find((x) => sameSha(x.sha, c.sha));
            if (seen) { if (!seen.branch && c.branch) seen.branch = c.branch; } else commits.push(c);
          }
          // The server takes MAX_STOP_COMMITS: the newest, so the turn's last commit (HEAD) is always among them.
          commits.splice(0, Math.max(0, commits.length - MAX_STOP_COMMITS));
        }
      } catch (e) { log(logDir, `stop: commit check failed: ${message(e)}`); }
      const r = await api.post<{ action: 'ok' | 'nudge'; reason?: string }>(
        '/api/hooks/turn/stop', stopBody(input, { answer, model, commits }), HOOK_BUDGET_MS.stop,
      ).catch((e) => { log(logDir, `stop failed: ${message(e)}`); return null; });
      // The saved HEAD absorbs every HEAD a Stop sees, so the HEAD-based detection (Codex) never takes a commit that
      // was already there — another session's, or the user's — for one of its own.
      if (observed && observed !== state.head) {
        try { saveState(logDir, input.sessionId, { ...state, head: observed }); } catch (e) { log(logDir, `session state not saved: ${message(e)}`); }
      }
      return r?.action === 'nudge' && r.reason ? formatOutput(agent, event, { nudge: r.reason }) : '';
    }

    if (event === 'session-end') {
      try {
        // A resumed session reuses its agent_session_id, so the key carries a per-call nonce; the outbox
        // replays the stored body, so retries of this same call keep the same key.
        const nonce = `${Date.now()}:${randomBytes(8).toString('hex')}`;
        const body = endBody(input, sha(`end:${input.sessionId}:${nonce}`).slice(0, 40));
        await deliver(api, outbox, logDir, '/api/hooks/session/end', body, left(1000), 'session-end');
      } finally {
        removeState(logDir, input.sessionId);
      }
      return '';
    }
    return '';
  } catch (e) {
    if (dir !== null) log(dir, `${agent} ${event} error: ${message(e)}`);
    return '';
  }
}
