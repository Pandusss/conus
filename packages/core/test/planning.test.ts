import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../../../test/helpers/db';
import { seedAgentSession } from '../../../test/helpers/fixtures';
import type { Db } from '../src/db';
import { getOverview } from '../src/overview';
import { endSession } from '../src/sessions';
import { renderSessionContext } from '../src/snapshot';
import { createTask, proposeTask } from '../src/tasks/create';
import { blockTask, completeTask, startTask } from '../src/tasks/lifecycle';
import { ownerSetPlanning, parseDueDate } from '../src/tasks/owner-ops';
import { getTaskById, getTaskDetail } from '../src/tasks/queries';
import type { Ctx, Task } from '../src/types';

let db: Db; let drop: () => Promise<void>;
beforeAll(async () => ({ db, drop } = await createTestDb()));
afterAll(async () => drop());
const owner = (): Ctx => ({ db, actor: { kind: 'user' } });

async function seed(remote: string, agentName?: string) {
  const s = await seedAgentSession(db, { remote, agentName });
  const ctx = { db, actor: s.actor };
  const mk = async (title: string): Promise<Task> => {
    const r = await createTask(ctx, { projectId: s.project.id, title, confirmNew: { reason: 't' } });
    if (r.outcome !== 'created') throw new Error('not created');
    return r.task;
  };
  return { ...s, ctx, mk };
}

describe('priority and due date', () => {
  it('new tasks are normal priority with no due date', async () => {
    const s = await seed('git@github.com:me/plan-defaults.git');
    const t = await s.mk('Plain task');
    expect(t).toMatchObject({ priority: 'normal', prioritySource: 'default', dueOn: null });
  });

  it('the owner sets both, pins the priority, and the history shows what changed', async () => {
    const s = await seed('git@github.com:me/plan-set.git');
    const t = await s.mk('Ship the release');
    const r = await ownerSetPlanning(owner(), { taskId: t.id, priority: 'urgent', dueOn: '2026-11-12' });
    expect(r.task).toMatchObject({ priority: 'urgent', prioritySource: 'owner', dueOn: '2026-11-12', version: t.version + 1 });
    const d = await getTaskDetail(db, t.id);
    expect(d?.events.at(-1)).toMatchObject({
      type: 'updated', actorKind: 'user', changes: { priority: { from: 'normal', to: 'urgent' }, due: { from: null, to: '2026-11-12' } },
    });
    // null clears the date and leaves the priority alone
    const cleared = await ownerSetPlanning(owner(), { taskId: t.id, dueOn: null });
    expect(cleared.task).toMatchObject({ priority: 'urgent', dueOn: null });
  });

  it('re-choosing the current priority only pins it, with no history event or version bump', async () => {
    const s = await seed('git@github.com:me/plan-pin.git');
    const t = await s.mk('Pin me');
    const before = (await getTaskDetail(db, t.id))!.events.length;
    const r = await ownerSetPlanning(owner(), { taskId: t.id, priority: 'normal' });
    expect(r.task).toMatchObject({ priority: 'normal', prioritySource: 'owner', version: t.version });
    expect((await getTaskDetail(db, t.id))!.events.length).toBe(before);
    // and asking again changes nothing at all
    const again = await ownerSetPlanning(owner(), { taskId: t.id, priority: 'normal' });
    expect(again.task.updatedAt).toEqual(r.task.updatedAt);
  });

  it('keeps the date as the calendar day, whatever the time zone', async () => {
    const s = await seed('git@github.com:me/plan-tz.git');
    const t = await s.mk('Due on the first');
    await ownerSetPlanning(owner(), { taskId: t.id, dueOn: '2027-01-01' });
    expect((await getTaskById(db, t.id))!.dueOn).toBe('2027-01-01');
  });

  it('refuses agents, bad priorities and impossible dates', async () => {
    const s = await seed('git@github.com:me/plan-bad.git');
    const t = await s.mk('Validate me');
    await expect(ownerSetPlanning(s.ctx, { taskId: t.id, priority: 'high' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(ownerSetPlanning(owner(), { taskId: t.id, priority: 'asap' as never })).rejects.toMatchObject({ code: 'validation' });
    for (const bad of ['2026-02-30', '2026-13-01', '26-11-12', '2026-11-12T00:00', '1999-12-31', 'tomorrow']) {
      expect(() => parseDueDate(bad), bad).toThrow(/YYYY-MM-DD/);
    }
    expect(parseDueDate('2028-02-29')).toBe('2028-02-29');
  });

  it('agents see their open tasks most important first, with priority and due date spelled out', async () => {
    const s = await seed('git@github.com:me/plan-snap.git');
    const low = await s.mk('Low chore');
    const plain = await s.mk('Plain work');
    const urgent = await s.mk('Fire');
    const dated = await s.mk('Has a deadline');
    await ownerSetPlanning(owner(), { taskId: low.id, priority: 'low' });
    await ownerSetPlanning(owner(), { taskId: urgent.id, priority: 'urgent' });
    await ownerSetPlanning(owner(), { taskId: dated.id, dueOn: '2026-11-20' });
    const text = await renderSessionContext(db, { session: s.session, project: s.project, agentName: 'a' });
    const lines = text.split('\n');
    const at = (ref: string) => lines.findIndex((l) => l.startsWith(`- ${ref} `));
    expect(text).toContain('Open, most important first (4 of 4):');
    expect(lines[at(urgent.ref)]).toBe(`- ${urgent.ref} «Fire» [todo · urgent]`);
    expect(lines[at(dated.ref)]).toBe(`- ${dated.ref} «Has a deadline» [todo · due 2026-11-20]`);
    expect(lines[at(plain.ref)]).toBe(`- ${plain.ref} «Plain work» [todo]`);
    expect(lines[at(low.ref)]).toBe(`- ${low.ref} «Low chore» [todo · low]`);
    // urgent, then (normal) the dated one before the undated one, then low
    expect([at(urgent.ref), at(dated.ref), at(plain.ref), at(low.ref)]).toEqual([...[at(urgent.ref), at(dated.ref), at(plain.ref), at(low.ref)]].sort((a, b) => a - b));
  });
});

describe('overview', () => {
  it('shows every project with counts, live sessions, work in each column and what waits for the owner', async () => {
    const a = await seed('git@github.com:me/ov-alpha.git', 'claude-code@ov');
    const doing = await a.mk('Alpha doing');
    await startTask(a.ctx, { projectId: a.project.id, task: doing.ref });
    const stuck = await a.mk('Alpha stuck');
    await blockTask(a.ctx, { projectId: a.project.id, task: stuck.ref, reason: 'needs API keys' });
    const check = await a.mk('Alpha check me');
    await startTask(a.ctx, { projectId: a.project.id, task: check.ref });
    await completeTask(a.ctx, { projectId: a.project.id, task: check.ref, result: 'done, please look', needsReview: true });
    const shipped = await a.mk('Alpha shipped');
    await startTask(a.ctx, { projectId: a.project.id, task: shipped.ref });
    await completeTask(a.ctx, { projectId: a.project.id, task: shipped.ref, result: 'shipped' });
    const later = await a.mk('Alpha later');
    const first = await a.mk('Alpha first');
    await ownerSetPlanning(owner(), { taskId: first.id, priority: 'high', dueOn: '2026-11-10' });
    await proposeTask(a.ctx, { projectId: a.project.id, title: 'Alpha idea', sourceQuote: 'maybe' });

    const b = await seed('git@github.com:me/ov-beta.git');
    await endSession(db, b.session.id, 'test');

    const o = await getOverview(db);
    const alpha = o.projects.find((p) => p.id === a.project.id)!;
    expect(alpha.counts).toEqual({ proposed: 1, todo: 2, in_progress: 1, blocked: 1, review: 1 });
    expect(alpha.doneThisWeek).toBe(1);
    expect(alpha.live.map((l) => l.ref)).toEqual([a.session.ref]);
    expect(alpha.live[0]!.agentName).toBe('claude-code@ov');
    expect(alpha.inProgress.map((t) => t.ref)).toEqual([doing.ref]);
    expect(alpha.inProgress[0]!.holder?.sessionRef).toBe(a.session.ref);
    expect(alpha.blocked.map((t) => t.blockReason)).toEqual(['needs API keys']);
    expect(alpha.review.map((t) => t.ref)).toEqual([check.ref]);
    expect(alpha.next.map((t) => t.ref)).toEqual([first.ref, later.ref]);
    expect(alpha.quiet).toBe(false);
    // the overview carries no long texts
    expect(alpha.next[0]).not.toHaveProperty('description');

    const beta = o.projects.find((p) => p.id === b.project.id)!;
    expect(beta.live).toEqual([]);
    expect(beta.quiet).toBe(false); // nothing open, but there was a session today
    // live projects come first
    expect(o.projects.findIndex((p) => p.id === a.project.id)).toBeLessThan(o.projects.findIndex((p) => p.id === b.project.id));

    expect(o.attention.review.map((t) => t.ref)).toContain(check.ref);
    expect(o.attention.blocked.map((t) => t.ref)).toContain(stuck.ref);
    expect(o.attention.dated.map((t) => t.ref)).toContain(first.ref);
    expect(o.attention.proposals).toBeGreaterThanOrEqual(1);
  });

  it('marks a project quiet when nothing is open and nothing happened for 30 days', async () => {
    const q = await seed('git@github.com:me/ov-quiet.git');
    await endSession(db, q.session.id, 'test');
    const later = new Date(Date.now() + 31 * 86_400_000);
    const o = await getOverview(db, later);
    expect(o.projects.find((p) => p.id === q.project.id)!.quiet).toBe(true);
  });
});
