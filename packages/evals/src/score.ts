import type { Status } from '@conus/core';
import type { Range, Scenario, TaskExpectation } from './scenario';

export interface EvalTask {
  ref: string; title: string; status: Status; type: 'task' | 'bug'; result: string | null; sourceQuote: string | null;
  parentRef: string | null; commits: number; seededIndex: number | null; createdInRun: boolean;
  /** The agent acted on the task in the run (any agent task event); always true for tasks it created. */
  touchedInRun: boolean;
}
/** Task operations the agent performed in the scenario's project (task_events with actor_kind = 'agent'). */
export interface OpCounts { created: number; proposed: number; started: number; blocked: number; completed: number; dropped: number }
export interface EvalState { tasks: EvalTask[]; nudges: number; nudgesActed: number; janitorReleases: number; duplicatePairs: number; ops: OpCounts }
export interface Check { name: string; ok: boolean; detail: string }

export const NO_OPS: OpCounts = Object.freeze({ created: 0, proposed: 0, started: 0, blocked: 0, completed: 0, dropped: 0 });

/** Event-type counts → OpCounts; `sent_to_review` (complete with review) counts as completed, other types are ignored. */
export function toOpCounts(rows: { type: string; n: number }[]): OpCounts {
  const ops = { ...NO_OPS };
  for (const { type, n } of rows) {
    const key = type === 'sent_to_review' ? 'completed' : type;
    if (Object.hasOwn(ops, key)) ops[key as keyof OpCounts] += n;
  }
  return ops;
}

const inRange = (n: number, r?: Range) => !r || ((r.min === undefined || n >= r.min) && (r.max === undefined || n <= r.max));
const fmt = (r?: Range) => `[${r?.min ?? 0}..${r?.max ?? '∞'}]`;

function matches(e: TaskExpectation, t: EvalTask): boolean {
  if (e.match.seed !== undefined) return t.seededIndex === e.match.seed;
  return new RegExp(e.match.titleLike!, 'i').test(t.title);
}

function satisfies(e: TaskExpectation, t: EvalTask): string[] {
  const why: string[] = [];
  if (e.status && !e.status.includes(t.status)) why.push(`status ${t.status} ∉ ${e.status.join('|')}`);
  if (e.type && t.type !== e.type) why.push(`type ${t.type}`);
  if (e.result === 'non_empty' && !t.result?.trim()) why.push('no result');
  if (e.commitsMin !== undefined && t.commits < e.commitsMin) why.push(`commits ${t.commits}`);
  if (e.hasParent !== undefined && !!t.parentRef !== e.hasParent) why.push(`parent ${t.parentRef ?? '—'}`);
  if (e.sourceQuote === 'non_empty' && !t.sourceQuote?.trim()) why.push('no source quote');
  return why;
}

/** Refs of the tasks created or touched in the run that are still in_progress (spec §14.3: nothing left hanging). */
export function leftInProgress(st: EvalState): string[] {
  return st.tasks.filter((t) => t.status === 'in_progress' && (t.createdInRun || t.touchedInRun)).map((t) => t.ref);
}

/**
 * `st` is the final state (after reconciliation). `atSessionEnd` is the state right after the agent's sessions
 * ended, before the janitor ran (defaults to `st`): no task the run created or touched may still be in_progress
 * then. A scenario that expects the janitor (a killed session) is judged after reconciliation instead.
 */
export function scoreScenario(s: Scenario, st: EvalState, atSessionEnd: EvalState = st): { passed: boolean; checks: Check[] } {
  const checks: Check[] = [];
  // A task's final status decides the bucket: a proposal promoted (or dropped) later counts as a created task.
  const createdTasks = st.tasks.filter((t) => t.createdInRun && t.status !== 'proposed');
  const proposals = st.tasks.filter((t) => t.createdInRun && t.status === 'proposed');
  if (s.expect.created) checks.push({ name: 'created', ok: inRange(createdTasks.length, s.expect.created), detail: `${createdTasks.length} ${fmt(s.expect.created)}` });
  if (s.expect.proposed) checks.push({ name: 'proposed', ok: inRange(proposals.length, s.expect.proposed), detail: `${proposals.length} ${fmt(s.expect.proposed)}` });
  s.expect.tasks.forEach((e, i) => {
    const candidates = st.tasks.filter((t) => matches(e, t));
    if (e.maxMatching !== undefined) {
      const alive = candidates.filter((t) => t.status !== 'dropped');
      checks.push({ name: `task[${i}]`, ok: alive.length <= e.maxMatching && alive.length > 0, detail: `${alive.length} matching non-dropped (max ${e.maxMatching})` });
      return;
    }
    const reasons = candidates.map((t) => ({ t, why: satisfies(e, t) }));
    const hit = reasons.find((r) => r.why.length === 0);
    checks.push({
      name: `task[${i}]`, ok: !!hit,
      detail: hit ? hit.t.ref : candidates.length ? reasons.map((r) => `${r.t.ref}: ${r.why.join(', ')}`).join('; ') : 'no matching task',
    });
  });
  checks.push({ name: 'nudges', ok: st.nudges <= s.expect.maxNudges, detail: `${st.nudges} (acted ${st.nudgesActed}) ≤ ${s.expect.maxNudges}` });
  checks.push({ name: 'janitor', ok: s.expect.janitorAllowed || st.janitorReleases === 0, detail: `${st.janitorReleases} releases` });
  const left = leftInProgress(s.expect.janitorAllowed ? st : atSessionEnd);
  checks.push({
    name: 'in_progress', ok: left.length === 0,
    detail: `${left.length ? left.join(', ') : 'none'} left in_progress ${s.expect.janitorAllowed ? 'after reconciliation' : 'after the session ended'}`,
  });
  checks.push({ name: 'duplicates', ok: st.duplicatePairs === 0, detail: `${st.duplicatePairs} near-duplicate pairs` });
  return { passed: checks.every((c) => c.ok), checks };
}
