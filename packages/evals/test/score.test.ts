import { describe, expect, it } from 'vitest';
import { parseScenario } from '../src/scenario';
import { leftInProgress, NO_OPS, scoreScenario, toOpCounts, type EvalState, type EvalTask } from '../src/score';

const t = (p: Partial<EvalTask>): EvalTask => ({ ref: 'E-1', title: 't', status: 'todo', type: 'task', result: null, sourceQuote: null, parentRef: null, commits: 0, seededIndex: null, createdInRun: true, touchedInRun: true, ...p });
const st = (tasks: EvalTask[], extra: Partial<EvalState> = {}): EvalState => ({ tasks, nudges: 0, nudgesActed: 0, janitorReleases: 0, duplicatePairs: 0, ops: NO_OPS, ...extra });
const feature = parseScenario(`
id: f
description: d
fixture: node-cli-small
turns: [{ user: x }]
expect:
  created: { min: 1, max: 1 }
  tasks:
    - match: { title_like: "json" }
      status: [done, review]
      result: non_empty
      commits_min: 1
  max_nudges: 1
`);

describe('scoreScenario', () => {
  it('passes a correct run', () => {
    const r = scoreScenario(feature, st([t({ title: 'Добавить флаг --json', status: 'done', result: 'ok', commits: 1 })]));
    expect(r.passed).toBe(true);
  });
  it('fails on wrong status, missing result, too many tasks, nudges, janitor and duplicates', () => {
    const bad = scoreScenario(feature, st(
      [t({ title: 'JSON output', status: 'in_progress', commits: 0 }), t({ ref: 'E-2', title: 'Extra' })],
      { nudges: 3, janitorReleases: 1, duplicatePairs: 1 },
    ));
    expect(bad.passed).toBe(false);
    const failed = bad.checks.filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toEqual(expect.arrayContaining(['created', 'task[0]', 'nudges', 'janitor', 'duplicates']));
  });
  it('matches seeded tasks by index and counts proposals separately', () => {
    const s = parseScenario('id: s\ndescription: d\nfixture: node-cli-small\nturns: [{ user: x }]\nexpect:\n  created: { max: 0 }\n  proposed: { min: 1 }\n  tasks:\n    - match: { seed: 0 }\n      status: [dropped]\n');
    const ok = scoreScenario(s, st([t({ seededIndex: 0, createdInRun: false, status: 'dropped' }), t({ ref: 'E-3', status: 'proposed', title: 'idea' })]));
    expect(ok.passed).toBe(true);
  });
  it('max_matching limits duplicates among non-dropped tasks', () => {
    const s = parseScenario('id: p\ndescription: d\nfixture: node-cli-small\nturns: [{ user: x }]\nexpect:\n  tasks:\n    - match: { title_like: "version" }\n      max_matching: 1\n');
    expect(scoreScenario(s, st([t({ title: 'Add --version' }), t({ ref: 'E-2', title: 'Version flag' })])).passed).toBe(false);
    expect(scoreScenario(s, st([t({ title: 'Add --version' }), t({ ref: 'E-2', title: 'Version flag', status: 'dropped' })])).passed).toBe(true);
  });
});

describe('nothing left in_progress after the session ended', () => {
  const plain = parseScenario('id: q\ndescription: d\nfixture: node-cli-small\nturns: [{ user: x }]\nexpect: {}\n');
  const killed = parseScenario('id: k\ndescription: d\nfixture: node-cli-small\nturns: [{ user: x }]\nexpect:\n  janitor_allowed: true\n');
  const check = (r: ReturnType<typeof scoreScenario>) => r.checks.find((c) => c.name === 'in_progress')!;

  it('lists tasks created or touched in the run that are still in_progress; an untouched seed does not count', () => {
    expect(leftInProgress(st([
      t({ ref: 'E-1', status: 'in_progress' }),
      t({ ref: 'E-2', status: 'in_progress', createdInRun: false, touchedInRun: true, seededIndex: 0 }),
      t({ ref: 'E-3', status: 'in_progress', createdInRun: false, touchedInRun: false, seededIndex: 1 }),
      t({ ref: 'E-4', status: 'done' }),
    ]))).toEqual(['E-1', 'E-2']);
  });

  it('fails the scenario on the state at session end (before reconciliation), even when the janitor later released it', () => {
    const atEnd = st([t({ ref: 'E-1', status: 'in_progress' })]);
    const after = st([t({ ref: 'E-1', status: 'todo' })], { janitorReleases: 1 });
    const r = scoreScenario(plain, after, atEnd);
    expect(r.passed).toBe(false);
    expect(check(r)).toMatchObject({ ok: false, detail: expect.stringContaining('E-1') });
    expect(check(scoreScenario(plain, st([t({ status: 'done' })]), st([t({ status: 'done' })])))).toMatchObject({ ok: true });
    // without a separate snapshot the given state is the one at session end
    expect(check(scoreScenario(plain, st([t({ status: 'in_progress' })])))).toMatchObject({ ok: false });
  });

  it('a scenario that expects the janitor (killed session) is judged after reconciliation', () => {
    const atEnd = st([t({ ref: 'E-1', status: 'in_progress' })]);
    expect(check(scoreScenario(killed, st([t({ ref: 'E-1', status: 'review' })]), atEnd))).toMatchObject({ ok: true });
    expect(check(scoreScenario(killed, st([t({ ref: 'E-1', status: 'in_progress' })]), atEnd))).toMatchObject({ ok: false });
  });
});

describe('toOpCounts', () => {
  it('maps agent task_events counts; sent_to_review counts as completed; unknown types are ignored', () => {
    expect(toOpCounts([
      { type: 'created', n: 2 }, { type: 'proposed', n: 1 }, { type: 'started', n: 3 }, { type: 'blocked', n: 1 },
      { type: 'completed', n: 1 }, { type: 'sent_to_review', n: 1 }, { type: 'dropped', n: 1 }, { type: 'noted', n: 9 },
    ])).toEqual({ created: 2, proposed: 1, started: 3, blocked: 1, completed: 2, dropped: 1 });
    expect(toOpCounts([])).toEqual(NO_OPS);
  });
});
