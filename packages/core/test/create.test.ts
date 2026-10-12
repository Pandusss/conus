import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../../../test/helpers/db';
import { seedAgentSession } from '../../../test/helpers/fixtures';
import type { Db } from '../src/db';
import { createTask, proposeTask } from '../src/tasks/create';
import { listTaskEvents } from '../src/events';

let db: Db; let drop: () => Promise<void>;
beforeAll(async () => ({ db, drop } = await createTestDb()));
afterAll(async () => drop());

describe('createTask', () => {
  it('creates todo with sequential numbers, event and chat note', async () => {
    const { project, actor } = await seedAgentSession(db, { remote: 'git@github.com:me/c1.git' });
    const r = await createTask({ db, actor }, { projectId: project.id, title: '  Добавить импорт CSV ', type: 'task', sourceQuote: 'давай сделаем импорт' });
    if (r.outcome !== 'created') throw new Error('expected created');
    expect(r.task.ref).toBe(`${project.key}-1`);
    expect(r.task.title).toBe('Добавить импорт CSV');
    expect(r.task.status).toBe('todo');
    expect(r.chatNote).toBe(`+${project.key}-1 Добавить импорт CSV`);
    const ev = await listTaskEvents(db, [r.task.id]);
    expect(ev.map((e) => e.type)).toEqual(['created']);
  });

  it('start_now claims the task for the session', async () => {
    const { project, actor, session } = await seedAgentSession(db, { remote: 'git@github.com:me/c2.git' });
    const r = await createTask({ db, actor }, { projectId: project.id, title: 'Implement export', startNow: true });
    if (r.outcome !== 'created') throw new Error('expected created');
    expect(r.task.status).toBe('in_progress');
    expect(r.task.claimedBySessionId).toBe(session.id);
    expect(r.task.claimExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 29 * 60_000);
    expect(r.chatNote).toBe(`+${r.task.ref} Implement export → in progress`);
    const ev = await listTaskEvents(db, [r.task.id]);
    expect(ev.map((e) => e.type)).toEqual(['created', 'claimed']);
    // Same shape as startTask's `claimed` event: session refs, not ids.
    expect(ev[1]!.changes).toEqual({ claimedBy: { from: null, to: session.ref } });
  });

  it('returns possible_duplicates and creates with confirm_new', async () => {
    const { project, actor } = await seedAgentSession(db, { remote: 'git@github.com:me/c3.git' });
    await createTask({ db, actor }, { projectId: project.id, title: 'Add CSV import' });
    const dup = await createTask({ db, actor }, { projectId: project.id, title: 'Add CSV import command' });
    expect(dup.outcome).toBe('possible_duplicates');
    const forced = await createTask({ db, actor }, { projectId: project.id, title: 'Add CSV import command', confirmNew: { reason: 'separate CLI command' } });
    expect(forced.outcome).toBe('created');
  });

  it('supports subtasks and bugs, validates input', async () => {
    const { project, actor } = await seedAgentSession(db, { remote: 'git@github.com:me/c4.git' });
    const parent = await createTask({ db, actor }, { projectId: project.id, title: 'Payments integration' });
    if (parent.outcome !== 'created') throw new Error();
    const sub = await createTask({ db, actor }, { projectId: project.id, title: 'Webhook signature check', parent: parent.task.ref, type: 'bug' });
    if (sub.outcome !== 'created') throw new Error();
    expect(sub.task.parentRef).toBe(parent.task.ref);
    expect(sub.task.type).toBe('bug');
    await expect(createTask({ db, actor }, { projectId: project.id, title: '   ' })).rejects.toMatchObject({ code: 'validation' });
    await expect(createTask({ db, actor }, { projectId: project.id, title: 'x'.repeat(201) })).rejects.toMatchObject({ code: 'validation' });
    await expect(createTask({ db, actor }, { projectId: project.id, title: 'Orphan', parent: 'ZZ-9' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects a parent from another project', async () => {
    const a = await seedAgentSession(db, { remote: 'git@github.com:me/c8a.git' });
    const b = await seedAgentSession(db, { remote: 'git@github.com:me/c8b.git' });
    const foreign = await createTask({ db, actor: b.actor }, { projectId: b.project.id, title: 'Foreign parent task' });
    if (foreign.outcome !== 'created') throw new Error();
    await expect(
      createTask({ db, actor: a.actor }, { projectId: a.project.id, title: 'Cross-project child', parent: foreign.task.ref }),
    ).rejects.toMatchObject({ code: 'validation' });
    const { rows } = await db.query('SELECT count(*)::int AS n FROM tasks WHERE project_id = $1', [a.project.id]);
    expect(rows[0].n).toBe(0);
  });

  it('reports an invalid parent before possible_duplicates', async () => {
    const { project, actor } = await seedAgentSession(db, { remote: 'git@github.com:me/c9.git' });
    await createTask({ db, actor }, { projectId: project.id, title: 'Add CSV import' });
    await expect(
      createTask({ db, actor }, { projectId: project.id, title: 'Add CSV import command', parent: 'ZZ-9' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('idempotency and races on create', () => {
  it('same key in parallel creates exactly one task', async () => {
    const { project, actor } = await seedAgentSession(db, { remote: 'git@github.com:me/c5.git' });
    const ctx = { db, actor, idempotencyKey: 'same-key' };
    const [a, b] = await Promise.all([
      createTask(ctx, { projectId: project.id, title: 'Parallel one' }),
      createTask(ctx, { projectId: project.id, title: 'Parallel one' }),
    ]);
    if (a.outcome !== 'created' || b.outcome !== 'created') throw new Error('both must report created');
    expect(a.task.id).toBe(b.task.id);
    const { rows } = await db.query('SELECT count(*)::int AS n FROM tasks WHERE project_id = $1', [project.id]);
    expect(rows[0].n).toBe(1);
  });

  it('different keys, same title in parallel: second sees the first as duplicate', async () => {
    const { project, actor } = await seedAgentSession(db, { remote: 'git@github.com:me/c6.git' });
    const res = await Promise.all([
      createTask({ db, actor, idempotencyKey: 'a' }, { projectId: project.id, title: 'Rate limiting for API' }),
      createTask({ db, actor, idempotencyKey: 'b' }, { projectId: project.id, title: 'Rate limiting for API' }),
    ]);
    expect(res.map((r) => r.outcome).sort()).toEqual(['created', 'possible_duplicates']);
  });

  it('a possible_duplicates answer is not stored: retry with the same key plus confirm_new creates', async () => {
    const { project, actor } = await seedAgentSession(db, { remote: 'git@github.com:me/c10.git' });
    await createTask({ db, actor }, { projectId: project.id, title: 'Add CSV import' });
    const ctx = { db, actor, idempotencyKey: 'K' };
    const first = await createTask(ctx, { projectId: project.id, title: 'Add CSV import command' });
    expect(first.outcome).toBe('possible_duplicates');
    const forced = await createTask(ctx, { projectId: project.id, title: 'Add CSV import command', confirmNew: { reason: 'separate CLI command' } });
    expect(forced.outcome).toBe('created');
    // the created outcome IS stored: replaying the same key returns the same task without a second insert
    const replay = await createTask(ctx, { projectId: project.id, title: 'Add CSV import command', confirmNew: { reason: 'separate CLI command' } });
    if (forced.outcome !== 'created' || replay.outcome !== 'created') throw new Error();
    expect(replay.task.id).toBe(forced.task.id);
    const { rows } = await db.query('SELECT count(*)::int AS n FROM tasks WHERE project_id = $1', [project.id]);
    expect(rows[0].n).toBe(2);
  });
});

describe('proposeTask', () => {
  it('requires a source quote and creates a proposal', async () => {
    const { project, actor } = await seedAgentSession(db, { remote: 'git@github.com:me/c7.git' });
    await expect(proposeTask({ db, actor }, { projectId: project.id, title: 'Cache layer', sourceQuote: ' ' })).rejects.toMatchObject({ code: 'validation' });
    const r = await proposeTask({ db, actor }, { projectId: project.id, title: 'Rework the cache layer', sourceQuote: 'надо бы когда-нибудь кэш переделать' });
    if (r.outcome !== 'created') throw new Error();
    expect(r.task.status).toBe('proposed');
    expect(r.task.sourceQuote).toBe('надо бы когда-нибудь кэш переделать');
    expect(r.chatNote).toBe(`?${r.task.ref} Rework the cache layer`);
  });
});
