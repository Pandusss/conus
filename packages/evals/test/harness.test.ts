import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../../../test/helpers/db';
import { seedAgentSession } from '../../../test/helpers/fixtures';
import type { Db } from '../../core/src/db';
import { blockTask, completeTask, dropTask, startTask } from '../../core/src/tasks/lifecycle';
import { createTask, proposeTask } from '../../core/src/tasks/create';
import { assertEvalDbClean, collectState, type Harness } from '../src/harness';

let db: Db; let drop: () => Promise<void>;
beforeAll(async () => ({ db, drop } = await createTestDb()));
afterAll(async () => drop());
const harness = (): Harness => ({ url: '', token: '', db, judgeEnabled: false, async stop() {} });

async function create(ctx: Parameters<typeof createTask>[0], projectId: string, title: string, parent?: string) {
  const r = await createTask(ctx, { projectId, title, parent, confirmNew: { reason: 'test' } });
  if (r.outcome !== 'created') throw new Error('not created');
  return r.task;
}

describe('collectState', () => {
  it('counts agent task operations from task_events (user operations excluded)', async () => {
    const s = await seedAgentSession(db, { remote: 'git@evals.local:evals/ops-1.git' });
    const ctx = { db, actor: s.actor };
    const p = s.project.id;
    const a = await create(ctx, p, 'Флаг --json');
    await startTask(ctx, { projectId: p, task: a.ref });
    await completeTask(ctx, { projectId: p, task: a.ref, result: 'done' });
    const b = await create(ctx, p, 'Отправка в Slack');
    await blockTask(ctx, { projectId: p, task: b.ref, reason: 'нет URL вебхука' });
    const c = await create(ctx, p, 'Экспорт в PDF');
    await dropTask(ctx, { projectId: p, task: c.ref, reason: 'отказались' });
    await proposeTask(ctx, { projectId: p, title: 'Переписать на commander', sourceQuote: 'надо бы когда-нибудь' });
    await createTask(ctx, { projectId: p, title: 'Цветной вывод ANSI', startNow: true, confirmNew: { reason: 'test' } }); // created + started
    const u = await create({ db, actor: { kind: 'user' } }, p, 'Задача владельца');
    await dropTask({ db, actor: { kind: 'user' } }, { projectId: p, task: u.ref, reason: 'x' });
    const st = await collectState(harness(), p, [u.id]);
    expect(st.ops).toEqual({ created: 4, proposed: 1, started: 2, blocked: 1, completed: 1, dropped: 1 });
    expect(st.tasks.find((t) => t.ref === u.ref)).toMatchObject({ seededIndex: 0, createdInRun: false, touchedInRun: false });
    expect(st.tasks.find((t) => t.ref === a.ref)).toMatchObject({ createdInRun: true, touchedInRun: true });
  });

  it('a seeded task is touched in the run once the agent acts on it', async () => {
    const s = await seedAgentSession(db, { remote: 'git@evals.local:evals/touch-1.git' });
    const p = s.project.id;
    const seed = await create({ db, actor: { kind: 'user' } }, p, 'Засеянная задача');
    expect((await collectState(harness(), p, [seed.id])).tasks[0]).toMatchObject({ touchedInRun: false });
    await startTask({ db, actor: s.actor }, { projectId: p, task: seed.ref });
    expect((await collectState(harness(), p, [seed.id])).tasks[0]).toMatchObject({ status: 'in_progress', touchedInRun: true });
  });

  it('near-duplicate pairs exclude parent/child pairs', async () => {
    const s = await seedAgentSession(db, { remote: 'git@evals.local:evals/dup-1.git' });
    const ctx = { db, actor: s.actor };
    const p = s.project.id;
    const parent = await create(ctx, p, 'Импорт CSV');
    await create(ctx, p, 'Импорт CSV', parent.ref);
    await create(ctx, p, 'Флаг --version');
    expect((await collectState(harness(), p, [])).duplicatePairs).toBe(0);
    await create(ctx, p, 'Импорт CSV'); // unrelated twin: pairs with the parent and with the child
    expect((await collectState(harness(), p, [])).duplicatePairs).toBe(2);
  });
});

describe('assertEvalDbClean', () => {
  it('refuses a database that already has projects unless EVAL_ALLOW_DIRTY_DB=1', async () => {
    await seedAgentSession(db, { remote: 'git@evals.local:evals/dirty.git' });
    await expect(assertEvalDbClean(db, {})).rejects.toThrow(/EVAL_ALLOW_DIRTY_DB=1/);
    await expect(assertEvalDbClean(db, { EVAL_ALLOW_DIRTY_DB: '1' })).resolves.toBeUndefined();
  });
  it('accepts an empty database and one without the schema yet', async () => {
    const fresh = await createTestDb();
    try {
      await expect(assertEvalDbClean(fresh.db, {})).resolves.toBeUndefined();
      await fresh.db.query('DROP TABLE projects CASCADE');
      await expect(assertEvalDbClean(fresh.db, {})).resolves.toBeUndefined();
    } finally {
      await fresh.drop();
    }
  });
});
