import { clamp } from '../clamp';
import type { RepoContext } from '../git';
import type { Fact } from './facts';
import type { HookInput } from './normalize';
import { headExcerpt, tailExcerpt } from './transcript';

/**
 * Request bodies of the hook API, built from the normalized hook input. Every string is clamped (surrogate-safe) to
 * the server's zod limits (packages/server/src/routes/hooks.ts), so an unusual value never turns a whole event into
 * a 400 that the outbox would drop. packages/server/test/hooks-contract.test.ts parses these with the server schemas.
 */
export const LIMITS = {
  sessionId: 200, cwd: 1000, remote: 500, rootName: 200, rootPathHash: 128, branch: 200, head: 64, model: 100,
  reason: 100, subject: 300, command: 300, tool: 50, task: 30,
} as const;

type GitCommit = Extract<Fact, { kind: 'git_commit' }>['data'];

function clampCommit(c: GitCommit): GitCommit {
  const branch = clamp(c.branch, LIMITS.branch);
  return { sha: c.sha, subject: clamp(c.subject, LIMITS.subject), ...(branch ? { branch } : {}), ...(c.amends ? { amends: c.amends } : {}) };
}

/** File paths are never shortened (that would name another file): extractFacts already drops those over 500. */
export function clampFact(f: Fact): Fact {
  switch (f.kind) {
    case 'git_commit': return { kind: 'git_commit', data: clampCommit(f.data) };
    case 'test_run': return { kind: 'test_run', data: { passed: f.data.passed, command: clamp(f.data.command, LIMITS.command) } };
    case 'task_op': {
      const task = clamp(f.data.task, LIMITS.task);
      return { kind: 'task_op', data: { tool: clamp(f.data.tool, LIMITS.tool), ...(task ? { task } : {}) } };
    }
    default: return f;
  }
}

const sessionId = (input: HookInput) => clamp(input.sessionId, LIMITS.sessionId);

export function startBody(input: HookInput, repo: RepoContext, cwd: string) {
  return {
    agent_session_id: sessionId(input), source: input.source, cwd: clamp(cwd, LIMITS.cwd), model: clamp(input.model, LIMITS.model),
    repo: {
      remote: clamp(repo.remote, LIMITS.remote), root_name: clamp(repo.rootName, LIMITS.rootName),
      root_path_hash: clamp(repo.rootPathHash, LIMITS.rootPathHash), branch: clamp(repo.branch, LIMITS.branch), head: clamp(repo.head, LIMITS.head),
    },
  };
}

export function promptBody(input: HookInput, sendText: boolean) {
  return { agent_session_id: sessionId(input), prompt_excerpt: sendText ? headExcerpt(input.prompt) : null };
}

export function activityBody(input: HookInput, facts: Fact[], idempotencyKey: string) {
  return { agent_session_id: sessionId(input), facts: facts.map(clampFact), idempotency_key: idempotencyKey };
}

/** Server limit on git_commit facts per /turn/stop (StopBody in packages/server/src/routes/hooks.ts). */
export const MAX_STOP_COMMITS = 10;

/** `answer` is the full last assistant message (or null when text sending is off); its tail is sent. */
export function stopBody(input: HookInput, opts: { answer: string | null; model: string | null; commits?: GitCommit[] }) {
  // The newest MAX_STOP_COMMITS (commits come oldest first): the turn's last commit, HEAD, is never cut.
  const commits = (opts.commits ?? []).slice(-MAX_STOP_COMMITS);
  return {
    agent_session_id: sessionId(input), stop_hook_active: input.stopHookActive, answer_excerpt: tailExcerpt(opts.answer),
    model: clamp(opts.model, LIMITS.model) || null,
    ...(commits.length ? { facts: commits.map((c) => ({ kind: 'git_commit' as const, data: clampCommit(c) })) } : {}),
  };
}

export function endBody(input: HookInput, idempotencyKey: string | null) {
  return { agent_session_id: sessionId(input), reason: clamp(input.reason, LIMITS.reason), idempotency_key: idempotencyKey };
}
