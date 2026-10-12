import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../../../test/helpers/db';
import { seedAgentSession } from '../../../test/helpers/fixtures';
import type { Db } from '../src/db';
import { createTask } from '../src/tasks/create';
import { blockTask, startTask } from '../src/tasks/lifecycle';
import { mergeDuplicate, ownerEditTask, ownerSetStatus, softDeleteTask } from '../src/tasks/owner-ops';
import { getTaskById, getTaskDetail, listTasks } from '../src/tasks/queries';
import { mergeProjects, getProjectById } from '../src/projects';
import type { Ctx } from '../src/types';

let db: Db; let drop: () => Promise<void>;
beforeAll(async () => ({ db, drop } = await createTestDb()));
afterAll(async () => drop());
const user: Ctx = { db: undefined as never, actor: { kind: 'user' } };

describe('owner ops', () => {
  it('sets any status, releases claims, records status_changed', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/o1.git' });
    const r = await createTask({ db, actor: s.actor }, { projectId: s.project.id, title: 'Owner moves me' });
    if (r.outcome !== 'created') throw new Error();
    await startTask({ db, actor: s.actor }, { projectId: s.project.id, task: r.task.ref });
    const res = await ownerSetStatus({ ...user, db }, { taskId: r.task.id, status: 'dropped' });
    expect(res.task.status).toBe('dropped');
    expect(res.task.claimedBySessionId).toBeNull();
    const d = await getTaskDetail(db, r.task.id);
    expect(d?.events.at(-1)).toMatchObject({ type: 'status_changed', actorKind: 'user', reason: 'Dropped by the owner' });
    await expect(ownerSetStatus({ db, actor: s.actor }, { taskId: r.task.id, status: 'todo' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('edits with version, merges duplicates, soft-deletes', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/o2.git' });
    const a = await createTask({ db, actor: s.actor }, { projectId: s.project.id, title: 'Main task' });
    const b = await createTask({ db, actor: s.actor }, { projectId: s.project.id, title: 'Same thing again', confirmNew: { reason: 't' } });
    if (a.outcome !== 'created' || b.outcome !== 'created') throw new Error();
    const ed = await ownerEditTask({ ...user, db }, { taskId: a.task.id, description: 'details', expectedVersion: a.task.version });
    expect(ed.task.description).toBe('details');
    const m = await mergeDuplicate({ ...user, db }, { duplicateId: b.task.id, intoId: a.task.id });
    expect(m.task.id).toBe(a.task.id);
    const dup = await getTaskById(db, b.task.id);
    expect(dup?.status).toBe('dropped');
    expect(dup?.mergedIntoId).toBe(a.task.id);
    const detail = await getTaskDetail(db, a.task.id);
    expect(detail?.events.some((e) => e.taskId === b.task.id && e.type === 'created')).toBe(true);
    await softDeleteTask({ ...user, db }, { taskId: b.task.id });
    expect((await listTasks(db, { projectId: s.project.id })).map((t) => t.id)).toEqual([a.task.id]);
  });

  it('merges projects renumbering tasks', async () => {
    const s1 = await seedAgentSession(db, { remote: 'git@github.com:me/p-from.git' });
    const s2 = await seedAgentSession(db, { remote: 'git@github.com:me/p-into.git' });
    await createTask({ db, actor: s2.actor }, { projectId: s2.project.id, title: 'Existing' });
    await createTask({ db, actor: s1.actor }, { projectId: s1.project.id, title: 'Moved one' });
    await mergeProjects(db, s1.project.id, s2.project.id);
    expect(await getProjectById(db, s1.project.id)).toBeNull();
    const into = await getProjectById(db, s2.project.id);
    expect(into?.repoFingerprints.sort()).toEqual(['github.com/me/p-from', 'github.com/me/p-into']);
    const tasks = await listTasks(db, { projectId: s2.project.id });
    expect(tasks.map((t) => t.number).sort()).toEqual([1, 2]);
  });

  it('leaving blocked clears the block; only the owner may use owner ops; deleted tasks are not found', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/o3.git' });
    const r = await createTask({ db, actor: s.actor }, { projectId: s.project.id, title: 'Owner unblocks' });
    if (r.outcome !== 'created') throw new Error();
    const agentCtx: Ctx = { db, actor: s.actor };
    await blockTask(agentCtx, { projectId: s.project.id, task: r.task.ref, reason: 'waiting' });
    const res = await ownerSetStatus({ ...user, db }, { taskId: r.task.id, status: 'todo' });
    expect(res.task.status).toBe('todo');
    expect(res.task.blockReason).toBeNull();
    const done = await ownerSetStatus({ ...user, db }, { taskId: r.task.id, status: 'done' });
    expect(done.task.closedAt).not.toBeNull();
    const reopened = await ownerSetStatus({ ...user, db }, { taskId: r.task.id, status: 'todo' });
    expect(reopened.task.closedAt).toBeNull();
    await expect(ownerEditTask(agentCtx, { taskId: r.task.id, title: 'x', expectedVersion: 1 })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(mergeDuplicate(agentCtx, { duplicateId: r.task.id, intoId: r.task.id })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(softDeleteTask(agentCtx, { taskId: r.task.id })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(ownerEditTask({ ...user, db }, { taskId: r.task.id, title: 'x', expectedVersion: 1 })).rejects.toMatchObject({ code: 'conflict_version' });
    await softDeleteTask({ ...user, db }, { taskId: r.task.id });
    await expect(ownerSetStatus({ ...user, db }, { taskId: r.task.id, status: 'todo' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(softDeleteTask({ ...user, db }, { taskId: r.task.id })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('opposite concurrent merges of the same pair do not deadlock', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/o4.git' });
    const mk = async (title: string) => {
      const r = await createTask({ db, actor: s.actor }, { projectId: s.project.id, title, confirmNew: { reason: 't' } });
      if (r.outcome !== 'created') throw new Error();
      return r.task;
    };
    const x = await mk('Task X');
    const y = await mk('Task Y');
    for (let i = 0; i < 5; i++) {
      const results = await Promise.allSettled([
        mergeDuplicate({ ...user, db }, { duplicateId: x.id, intoId: y.id }),
        mergeDuplicate({ ...user, db }, { duplicateId: y.id, intoId: x.id }),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    }
  });

  it('merge projects: moved events carry old and new refs; sessions follow; soft-deleted tasks move too', async () => {
    const s1 = await seedAgentSession(db, { remote: 'git@github.com:me/q-from.git' });
    const s2 = await seedAgentSession(db, { remote: 'git@github.com:me/q-into.git' });
    const t1 = await createTask({ db, actor: s1.actor }, { projectId: s1.project.id, title: 'Alpha one' });
    const t2 = await createTask({ db, actor: s1.actor }, { projectId: s1.project.id, title: 'Beta two', confirmNew: { reason: 't' } });
    if (t1.outcome !== 'created' || t2.outcome !== 'created') throw new Error();
    await softDeleteTask({ ...user, db }, { taskId: t2.task.id });
    await mergeProjects(db, s1.project.id, s2.project.id);
    const moved = await getTaskById(db, t1.task.id);
    expect(moved?.projectId).toBe(s2.project.id);
    expect(moved?.ref).toBe(`${s2.project.key}-1`);
    expect((await getTaskById(db, t2.task.id))?.ref).toBe(`${s2.project.key}-2`);
    const ev = (await getTaskDetail(db, t1.task.id))?.events.at(-1);
    expect(ev).toMatchObject({ type: 'moved', actorKind: 'user' });
    expect(ev?.changes).toMatchObject({ ref: { from: t1.task.ref, to: `${s2.project.key}-1` } });
    const sess = await db.query('SELECT project_id FROM sessions WHERE id = $1', [s1.session.id]);
    expect(sess.rows[0].project_id).toBe(s2.project.id);
    await expect(mergeProjects(db, s2.project.id, s2.project.id)).rejects.toMatchObject({ code: 'validation' });
    await expect(mergeProjects(db, s1.project.id, s2.project.id)).rejects.toMatchObject({ code: 'not_found' });
  });
});
