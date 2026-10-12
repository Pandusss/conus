import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../../../test/helpers/db';
import { seedAgentSession } from '../../../test/helpers/fixtures';
import { withTx, type Db } from '../src/db';
import { appendEvent, listTaskEvents } from '../src/events';
import { getTaskByRef, getTaskDetail, listTasks, countByStatus } from '../src/tasks/queries';
import { idempotent } from '../src/idempotency';
import type { Actor, CreateOutcome, MutationResult } from '../src/types';

let db: Db; let drop: () => Promise<void>;
beforeAll(async () => ({ db, drop } = await createTestDb()));
afterAll(async () => drop());

async function insertTask(projectId: string, number: number, title: string, status = 'todo', extra = '') {
  const { rows } = await db.query(
    `INSERT INTO tasks(project_id, number, type, title, status, description) VALUES ($1,$2,'task',$3,$4,$5) RETURNING id`,
    [projectId, number, title, status, extra],
  );
  return rows[0].id as string;
}

describe('read model', () => {
  it('resolves refs with and without key, lists and filters', async () => {
    const { project } = await seedAgentSession(db);
    await insertTask(project.id, 1, 'Добавить импорт CSV');
    const id2 = await insertTask(project.id, 2, 'Fix login redirect', 'in_progress');
    await db.query('UPDATE tasks SET parent_id = $1 WHERE number = 1 AND project_id = $2', [id2, project.id]);
    const t = await getTaskByRef(db, project.id, `${project.key}-1`);
    expect(t.ref).toBe(`${project.key}-1`);
    expect(t.parentRef).toBe(`${project.key}-2`);
    expect((await getTaskByRef(db, project.id, '2')).title).toBe('Fix login redirect');
    await expect(getTaskByRef(db, project.id, '77')).rejects.toMatchObject({ code: 'not_found' });
    expect((await listTasks(db, { projectId: project.id, statuses: ['in_progress'] })).map((x) => x.number)).toEqual([2]);
    expect((await listTasks(db, { projectId: project.id, query: 'импорт' })).map((x) => x.number)).toEqual([1]);
    const counts = await countByStatus(db, project.id);
    expect(counts.todo).toBe(1);
    expect(counts.in_progress).toBe(1);
    expect(counts.done).toBe(0);
  });

  it('lists and details tasks with the board extras: project name, holder, live subtask and commit counts', async () => {
    const { project, agent, session } = await seedAgentSession(db, { remote: 'git@github.com:me/view.git' });
    const parent = await insertTask(project.id, 1, 'Parent with children');
    const kid1 = await insertTask(project.id, 2, 'Kid one');
    const kid2 = await insertTask(project.id, 3, 'Kid two (deleted)');
    const lone = await insertTask(project.id, 4, 'Nothing attached');
    await db.query('UPDATE tasks SET parent_id = $1 WHERE id = ANY($2)', [parent, [kid1, kid2]]);
    await db.query('UPDATE tasks SET deleted_at = now() WHERE id = $1', [kid2]);
    await db.query(`UPDATE tasks SET status = 'in_progress', claimed_by_session_id = $2 WHERE id = $1`, [parent, session.id]);
    await db.query(
      `INSERT INTO links(task_id, kind, ref, meta) VALUES ($1,'commit','aaaa001','{}'), ($1,'commit','aaaa002','{}'), ($1,'branch','feat/x','{}')`,
      [parent],
    );

    const listed = await listTasks(db, { projectId: project.id });
    const byId = new Map(listed.map((t) => [t.id, t]));
    expect(byId.get(parent)).toMatchObject({
      projectName: project.name, subtaskCount: 1, commitCount: 2,
      holder: { agentName: agent.name, sessionRef: session.ref, sessionId: session.id },
    });
    expect(byId.get(lone)).toMatchObject({ projectName: project.name, subtaskCount: 0, commitCount: 0, holder: null });
    expect(byId.has(kid2)).toBe(false);

    const detail = await getTaskDetail(db, parent);
    expect(detail?.task).toMatchObject({ subtaskCount: 1, commitCount: 2, holder: { sessionRef: session.ref }, projectName: project.name });
    expect(detail?.subtasks.map((t) => [t.id, t.subtaskCount, t.holder])).toEqual([[kid1, 0, null]]);
    expect(await getTaskDetail(db, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('appends sequential events with actor names and returns them in detail', async () => {
    const { project, actor, agent, session } = await seedAgentSession(db, { remote: 'git@github.com:me/ev.git' });
    const id = await insertTask(project.id, 1, 'Event task');
    await appendEvent(db, { taskId: id, type: 'created', actor, changes: { status: { from: null, to: 'todo' } } });
    await appendEvent(db, { taskId: id, type: 'noted', actor: { kind: 'user' }, note: 'hello' });
    const ev = await listTaskEvents(db, [id]);
    expect(ev.map((e) => [e.seq, e.type, e.actorKind])).toEqual([[1, 'created', 'agent'], [2, 'noted', 'user']]);
    expect(ev[0]?.actorName).toBe(agent.name);
    expect(ev[0]?.sessionRef).toBe(session.ref);
    const detail = await getTaskDetail(db, id);
    expect(detail?.events).toHaveLength(2);
    expect(detail?.links).toEqual([]);
  });

  it('serializes concurrent appends to one task: all succeed with gapless seqs', async () => {
    const { project, actor } = await seedAgentSession(db, { remote: 'git@github.com:me/conc.git' });
    const id = await insertTask(project.id, 1, 'Concurrent events');
    const N = 5;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        withTx(db, (tx) => appendEvent(tx, { taskId: id, type: 'noted', actor, note: `n${i}` }))),
    );
    const ev = await listTaskEvents(db, [id]);
    expect(ev.map((e) => e.seq).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(ev.map((e) => e.note)).size).toBe(N);
  });
});

describe('idempotent', () => {
  it('runs once per (agent, op, key) and replays the stored result', async () => {
    const { project, actor } = await seedAgentSession(db, { remote: 'git@github.com:me/idem.git' });
    const id = await insertTask(project.id, 1, 'Idem');
    let runs = 0;
    const run = async (): Promise<MutationResult> => {
      runs++;
      const task = await getTaskByRef(db, project.id, '1');
      return { task, chatNote: 'note' };
    };
    const ctx = { db, actor, idempotencyKey: 'k1' };
    const a = await idempotent(ctx, 'start', run);
    const b = await idempotent(ctx, 'start', run);
    expect(runs).toBe(1);
    expect(b.task.id).toBe(id);
    expect(b.chatNote).toBe(a.chatNote);
    await idempotent({ ...ctx, idempotencyKey: 'k1' }, 'complete', run); // different op → runs
    expect(runs).toBe(2);
    const user: Actor = { kind: 'user' };
    await idempotent({ db, actor: user, idempotencyKey: 'k1' }, 'start', run); // users are never deduped
    expect(runs).toBe(3);
  });

  it('does not store a possible_duplicates outcome (no side effect to protect)', async () => {
    const { actor } = await seedAgentSession(db, { remote: 'git@github.com:me/idem-dup.git' });
    let runs = 0;
    const ctx = { db, actor, idempotencyKey: 'dup-k' };
    const dup = async (): Promise<CreateOutcome> => {
      runs++;
      return { outcome: 'possible_duplicates', candidates: [{ ref: 'X-1', title: 'T', status: 'todo', score: 0.9 }] };
    };
    expect((await idempotent(ctx, 'create', dup)).outcome).toBe('possible_duplicates');
    expect((await idempotent(ctx, 'create', dup)).outcome).toBe('possible_duplicates');
    expect(runs).toBe(2);
    const { rows } = await db.query("SELECT count(*)::int AS n FROM idempotency_keys WHERE key = 'create:dup-k'");
    expect(rows[0].n).toBe(0);
  });
});
