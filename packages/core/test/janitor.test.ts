import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../../../test/helpers/db';
import { seedAgentSession } from '../../../test/helpers/fixtures';
import type { Db } from '../src/db';
import { recordFacts } from '../src/activity';
import { agentHealthRollup } from '../src/health';
import { runJanitor, unownedReleaseNote } from '../src/janitor';
import { NullJudge, OK_VERDICT, type Judge } from '../src/judge-types';
import { endSession, getSessionById } from '../src/sessions';
import { createTask } from '../src/tasks/create';
import { releaseUnownedTask, startTask, updateTask } from '../src/tasks/lifecycle';
import { ownerSetStatus } from '../src/tasks/owner-ops';
import { getTaskById, getTaskDetail } from '../src/tasks/queries';

let db: Db; let drop: () => Promise<void>;
beforeAll(async () => ({ db, drop } = await createTestDb()));
afterAll(async () => drop());

describe('runJanitor', () => {
  it('marks silent sessions stale and releases their tasks: evidence → review with auto summary, none → todo', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/j1.git' });
    const a = await createTask({ db, actor: s.actor }, { projectId: s.project.id, title: 'With evidence', startNow: true });
    const b = await createTask({ db, actor: s.actor }, { projectId: s.project.id, title: 'No evidence at all', startNow: true, confirmNew: { reason: 't' } });
    if (a.outcome !== 'created' || b.outcome !== 'created') throw new Error();
    await recordFacts(db, s.session.id, [{ kind: 'git_commit', data: { sha: 'abc1234', subject: 'feat: work' } }, { kind: 'file_edit', data: { path: 'src/x.ts' } }]);
    // evidence belongs to the session; attribute it to task A only by making B's claim start later
    await db.query(`UPDATE task_events SET created_at = now() + interval '1 minute' WHERE task_id = $1`, [b.task.id]);
    const later = new Date(Date.now() + 31 * 60_000);
    const res = await runJanitor({ db, judge: new NullJudge() }, later);
    expect(res.staled).toBe(1);
    expect((await getSessionById(db, s.session.id))?.state).toBe('stale');
    const ta = await getTaskById(db, a.task.id);
    const tb = await getTaskById(db, b.task.id);
    expect(ta?.status).toBe('review');
    expect(ta?.result).toBe('Auto summary (system): commits: abc1234 feat: work; files: src/x.ts');
    expect(tb?.status).toBe('todo');
    expect(res.released.map((r) => r.to).sort()).toEqual(['review', 'todo']);
  });

  it('releases tasks of ended sessions immediately and never touches active ones or a fresh unclaimed in_progress', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/j2.git' });
    const active = await seedAgentSession(db, { remote: 'git@github.com:me/j2.git' });
    const x = await createTask({ db, actor: s.actor }, { projectId: s.project.id, title: 'Ended session task', startNow: true });
    const y = await createTask({ db, actor: active.actor }, { projectId: s.project.id, title: 'Active session task', startNow: true, confirmNew: { reason: 't' } });
    await db.query(`INSERT INTO tasks(project_id, number, type, title, status) VALUES ($1, 900, 'task', 'Unclaimed, fresh', 'in_progress')`, [s.project.id]);
    if (x.outcome !== 'created' || y.outcome !== 'created') throw new Error();
    await endSession(db, s.session.id, 'exit');
    await runJanitor({ db, judge: new NullJudge() });
    expect((await getTaskById(db, x.task.id))?.status).toBe('todo');
    expect((await getTaskById(db, y.task.id))?.status).toBe('in_progress');
    const { rows } = await db.query(`SELECT status FROM tasks WHERE number = 900 AND project_id = $1`, [s.project.id]);
    expect(rows[0].status).toBe('in_progress');
  });

  it('backstop: in_progress nobody claims (started without a session) goes back to todo after a quiet day (long sessionless work is not cut off)', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/j4.git' });
    // An MCP call that resolved no session: the agent is known, the session is not.
    const sessionless = { db, actor: { kind: 'agent' as const, agentId: s.agent.id, sessionId: null, model: null } };
    const a = await createTask(sessionless, { projectId: s.project.id, title: 'Started without a session', startNow: true });
    const b = await createTask(sessionless, { projectId: s.project.id, title: 'Started later without session', confirmNew: { reason: 't' } });
    if (a.outcome !== 'created' || b.outcome !== 'created') throw new Error();
    await startTask(sessionless, { projectId: s.project.id, task: b.task.ref });
    expect((await getTaskById(db, a.task.id))?.claimedBySessionId).toBeNull();
    // the owner's own "in progress" is the owner's: never released
    const o = await createTask({ db, actor: { kind: 'user' } }, { projectId: s.project.id, title: 'Owner works on it', confirmNew: { reason: 't' } });
    if (o.outcome !== 'created') throw new Error();
    await ownerSetStatus({ db, actor: { kind: 'user' } }, { taskId: o.task.id, status: 'in_progress' });

    // hours of quiet work (e.g. a long implementation between two MCP calls): untouched
    // (other tests of this file leave sessions behind that go stale by then: look only at this test's tasks)
    const early = await runJanitor({ db, judge: new NullJudge() }, new Date(Date.now() + 23 * 3600_000));
    expect(early.released.filter((r) => [a.task.ref, b.task.ref, o.task.ref].includes(r.ref))).toEqual([]);
    expect((await getTaskById(db, a.task.id))?.status).toBe('in_progress');
    // a fresh event (a note) restarts the quiet period of B only
    await db.query(`UPDATE task_events SET created_at = created_at - interval '25 hours' WHERE task_id = ANY($1)`, [[a.task.id, b.task.id, o.task.id]]);
    await db.query(`UPDATE tasks SET updated_at = updated_at - interval '25 hours' WHERE id = ANY($1)`, [[a.task.id, b.task.id, o.task.id]]);
    await updateTask(sessionless, { projectId: s.project.id, task: b.task.ref, note: 'still on it' });

    const res = await runJanitor({ db, judge: new NullJudge() });
    expect(res.released).toEqual([{ ref: a.task.ref, to: 'todo' }]);
    const ta = await getTaskDetail(db, a.task.id);
    expect(ta?.task.status).toBe('todo');
    const ev = ta!.events.at(-1)!;
    expect(ev).toMatchObject({ type: 'claim_released', actorKind: 'system', changes: { status: { from: 'in_progress', to: 'todo' } } });
    expect(ev.note).toBe(unownedReleaseNote());
    expect(ev.note).toMatch(/^Reconciliation \(system\): /);
    expect((await getTaskById(db, b.task.id))?.status).toBe('in_progress');
    expect((await getTaskById(db, o.task.id))?.status).toBe('in_progress');
    // never done, and it counts as a janitor intervention of the agent that started the task
    expect((await agentHealthRollup(db)).find((r) => r.agentId === s.agent.id)?.janitorReleases).toBe(1);
  });

  it('backstop re-checks under the row lock: an event after the scan keeps the task', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/j5.git' });
    const sessionless = { db, actor: { kind: 'agent' as const, agentId: s.agent.id, sessionId: null, model: null } };
    const a = await createTask(sessionless, { projectId: s.project.id, title: 'Racy sessionless task', startNow: true });
    if (a.outcome !== 'created') throw new Error();
    const idleSince = new Date(Date.now() - 60_000);
    expect(await releaseUnownedTask({ db, actor: { kind: 'system' } }, { taskId: a.task.id, idleSince, note: 'x' })).toBeNull();
    expect((await getTaskById(db, a.task.id))?.status).toBe('in_progress');
  });

  it('falls back to the deterministic summary when the judge summarize throws', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/j3.git' });
    const a = await createTask({ db, actor: s.actor }, { projectId: s.project.id, title: 'Flaky judge job', startNow: true });
    if (a.outcome !== 'created') throw new Error();
    await recordFacts(db, s.session.id, [{ kind: 'git_commit', data: { sha: 'def5678', subject: 'feat: flaky' } }, { kind: 'file_edit', data: { path: 'src/y.ts' } }]);
    const judge: Judge = {
      enabled: true,
      evaluate: async () => OK_VERDICT,
      summarize: async () => { throw new Error('judge exploded'); },
    };
    const res = await runJanitor({ db, judge }, new Date(Date.now() + 31 * 60_000));
    expect(res.released).toContainEqual({ ref: a.task.ref, to: 'review' });
    const ta = await getTaskById(db, a.task.id);
    expect(ta?.status).toBe('review');
    expect(ta?.result).toBe('Auto summary (system): commits: def5678 feat: flaky; files: src/y.ts');
  });
});
