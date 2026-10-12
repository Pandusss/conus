import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../../../test/helpers/db';
import { seedAgentSession, seedSecondSession } from '../../../test/helpers/fixtures';
import type { Db } from '../src/db';
import { endSession, touchSession } from '../src/sessions';
import { createTask, proposeTask } from '../src/tasks/create';
import { blockTask, completeTask, dropTask, janitorRelease, linkCommit, startTask, updateTask } from '../src/tasks/lifecycle';
import { getTaskById, getTaskDetail } from '../src/tasks/queries';
import type { Ctx, Task } from '../src/types';

let db: Db; let drop: () => Promise<void>;
beforeAll(async () => ({ db, drop } = await createTestDb()));
afterAll(async () => drop());

async function setup(remote: string) {
  const s = await seedAgentSession(db, { remote });
  const ctx: Ctx = { db, actor: s.actor };
  const mk = async (title: string): Promise<Task> => {
    const r = await createTask(ctx, { projectId: s.project.id, title, confirmNew: { reason: 'test' } });
    if (r.outcome !== 'created') throw new Error();
    return r.task;
  };
  return { ...s, ctx, mk };
}

describe('lifecycle', () => {
  it('start → block → start → complete with commits', async () => {
    const { ctx, project, session, mk } = await setup('git@github.com:me/l1.git');
    const t = await mk('Import CSV');
    const s1 = await startTask(ctx, { projectId: project.id, task: t.ref });
    expect(s1.task.status).toBe('in_progress');
    expect(s1.task.claimedBySessionId).toBe(session.id);
    expect(s1.chatNote).toBe(`${t.ref} → in progress`);
    const b = await blockTask(ctx, { projectId: project.id, task: t.ref, reason: 'нужны доступы к API' });
    expect(b.task.status).toBe('blocked');
    expect(b.task.blockReason).toBe('нужны доступы к API');
    expect(b.task.claimedBySessionId).toBeNull();
    await startTask(ctx, { projectId: project.id, task: t.ref });
    const c = await completeTask(ctx, { projectId: project.id, task: t.ref, result: 'Done: parser + tests', commits: ['abc1234'] });
    expect(c.task.status).toBe('done');
    expect(c.task.closedAt).not.toBeNull();
    expect(c.task.claimedBySessionId).toBeNull();
    expect(c.task.result).toBe('Done: parser + tests');
    expect(c.task.version).toBe(5);
    const d = await getTaskDetail(db, t.id);
    expect(d?.links.map((l) => l.ref)).toEqual(['abc1234']);
    expect(d?.events.map((e) => e.type)).toEqual(['created', 'started', 'blocked', 'started', 'completed']);
  });

  it('needs_review goes to review; drop requires reason; invalid transitions are reported', async () => {
    const { ctx, project, mk } = await setup('git@github.com:me/l2.git');
    const t = await mk('Feature A');
    const r = await completeTask(ctx, { projectId: project.id, task: t.ref, result: 'check UI', needsReview: true });
    expect(r.task.status).toBe('review');
    expect(r.chatNote).toBe(`${t.ref} → review`);
    await expect(dropTask(ctx, { projectId: project.id, task: t.ref, reason: '' })).rejects.toMatchObject({ code: 'validation' });
    const dr = await dropTask(ctx, { projectId: project.id, task: t.ref, reason: 'не будем делать' });
    expect(dr.task.status).toBe('dropped');
    await expect(blockTask(ctx, { projectId: project.id, task: t.ref, reason: 'x' })).rejects.toMatchObject({ code: 'invalid_transition', details: { current: 'dropped' } });
  });

  it('update: note, versioned edit, promote, reopen', async () => {
    const { ctx, project, actor } = await setup('git@github.com:me/l3.git');
    const p = await proposeTask(ctx, { projectId: project.id, title: 'Cache rework', sourceQuote: 'когда-нибудь' });
    if (p.outcome !== 'created') throw new Error();
    const pr = await updateTask(ctx, { projectId: project.id, task: p.task.ref, promote: true });
    expect(pr.task.status).toBe('todo');
    expect(pr.chatNote).toBe(`${p.task.ref} → to do`);
    const noted = await updateTask(ctx, { projectId: project.id, task: p.task.ref, note: 'progress' });
    expect(noted.task.version).toBe(pr.task.version);
    await expect(updateTask(ctx, { projectId: project.id, task: p.task.ref, title: 'New' })).rejects.toMatchObject({ code: 'validation' });
    await expect(updateTask(ctx, { projectId: project.id, task: p.task.ref, title: 'New', expectedVersion: 99 })).rejects.toMatchObject({ code: 'conflict_version', details: { currentVersion: pr.task.version } });
    const ed = await updateTask(ctx, { projectId: project.id, task: p.task.ref, title: 'Cache layer rework', expectedVersion: pr.task.version });
    expect(ed.task.title).toBe('Cache layer rework');
    await completeTask({ db, actor }, { projectId: project.id, task: p.task.ref, result: 'ok' });
    const ro = await updateTask(ctx, { projectId: project.id, task: p.task.ref, reopen: { reason: 'regression' } });
    expect(ro.task.status).toBe('todo');
    expect(ro.task.closedAt).toBeNull();
    await expect(updateTask(ctx, { projectId: project.id, task: p.task.ref })).rejects.toMatchObject({ code: 'validation' });
  });

  it('block resolves blockedBy by ref (not itself); start clears the block', async () => {
    const { ctx, project, mk } = await setup('git@github.com:me/l5.git');
    const a = await mk('Blocked task');
    const b = await mk('The blocker');
    await expect(blockTask(ctx, { projectId: project.id, task: a.ref, reason: 'x', blockedBy: a.ref })).rejects.toMatchObject({ code: 'validation' });
    const blocked = await blockTask(ctx, { projectId: project.id, task: a.ref, reason: 'ждём blocker', blockedBy: b.ref });
    expect(blocked.task.blockedByRef).toBe(b.ref);
    const again = await startTask(ctx, { projectId: project.id, task: a.ref });
    expect(again.task.blockReason).toBeNull();
    expect(again.task.blockedByRef).toBeNull();
    const d = await getTaskDetail(db, a.id);
    expect(d?.events.find((e) => e.type === 'blocked')?.changes).toMatchObject({ blockedBy: { from: null, to: b.ref } });
  });

  it('re-sending the current title is not a change', async () => {
    const { ctx, project, mk } = await setup('git@github.com:me/l6.git');
    const t = await mk('Stable title');
    const r = await updateTask(ctx, { projectId: project.id, task: t.ref, title: 'Stable title', expectedVersion: t.version });
    expect(r.task.version).toBe(t.version);
    expect((await getTaskDetail(db, t.id))?.events.map((e) => e.type)).toEqual(['created']);
  });

  it('chat note precedence: reopened > promoted > updated; note-only keeps the version', async () => {
    const { ctx, project, mk } = await setup('git@github.com:me/l7.git');
    const t = await mk('Closed then reopened');
    await dropTask(ctx, { projectId: project.id, task: t.ref, reason: 'oops' });
    const r = await updateTask(ctx, { projectId: project.id, task: t.ref, reopen: { reason: 'нужна' }, note: 'details' });
    expect(r.chatNote).toBe(`${t.ref} → reopened`);
    expect(r.task.status).toBe('todo');
    const n = await updateTask(ctx, { projectId: project.id, task: t.ref, note: 'just a note' });
    expect(n.chatNote).toBe(`${t.ref} updated`);
    expect(n.task.version).toBe(r.task.version);
  });

  it('janitorRelease to todo records claim_released with the previous session ref', async () => {
    const { ctx, project, session, mk } = await setup('git@github.com:me/l8.git');
    const t = await mk('Abandoned job');
    await startTask(ctx, { projectId: project.id, task: t.ref });
    await endSession(db, session.id, 'exit');
    const rel = await janitorRelease({ db, actor: { kind: 'system' } }, { taskId: t.id, to: 'todo', expectedSessionId: session.id });
    expect(rel?.task.status).toBe('todo');
    expect(rel?.task.claimedBySessionId).toBeNull();
    const last = (await getTaskDetail(db, t.id))?.events.at(-1);
    expect(last).toMatchObject({ type: 'claim_released', actorKind: 'system' });
    expect(last?.changes).toMatchObject({ claimedBy: { from: session.ref, to: null } });
  });

  it('linkCommit with amends removes the amended link (full or short sha), keeps its event, and records the amend', async () => {
    const { ctx, project, mk } = await setup('git@github.com:me/l11.git');
    const t = await mk('Amended work');
    await startTask(ctx, { projectId: project.id, task: t.ref });
    const old = 'abcdef1234567890abcdef1234567890abcdef12';
    // the agent passed a short sha to task_complete-style linking; the hook later reports the amend with the full sha
    expect(await linkCommit(ctx, { taskId: t.id, sha: 'abcdef1', subject: 'wip' })).toBe(true);
    expect(await linkCommit(ctx, { taskId: t.id, sha: '1111111111111111111111111111111111111111', subject: 'fix', amends: old })).toBe(true);
    const d = await getTaskDetail(db, t.id);
    expect(d?.links.map((l) => l.ref)).toEqual(['1111111111111111111111111111111111111111']);
    expect(d?.links[0]?.meta).toMatchObject({ subject: 'fix', amends: old });
    expect(d?.events.filter((e) => e.type === 'commit_linked')).toHaveLength(2);
    // an amend of a commit that was never linked just links the new one
    expect(await linkCommit(ctx, { taskId: t.id, sha: '2222222', subject: 'x', amends: '9999999' })).toBe(true);
    expect((await getTaskDetail(db, t.id))?.links.map((l) => l.ref).sort()).toEqual(['1111111111111111111111111111111111111111', '2222222']);
  });

  it('a short and a full sha of the same commit are one link: no second link, the short row is upgraded keeping its subject', async () => {
    const { ctx, project, mk } = await setup('git@github.com:me/l12.git');
    const full = 'abcdef1234567890abcdef1234567890abcdef12';
    // task_complete names the commit by a short sha (no subject); the Stop check then links the full one
    const a = await mk('Short then full');
    await startTask(ctx, { projectId: project.id, task: a.ref });
    await completeTask(ctx, { projectId: project.id, task: a.ref, result: 'done', commits: ['ABCDEF1', full.slice(0, 10), 'abcdef1'] });
    let d = await getTaskDetail(db, a.id);
    expect(d?.links.map((l) => l.ref)).toEqual([full.slice(0, 10)]); // one row, upgraded to the longest ref seen
    expect(await linkCommit(ctx, { taskId: a.id, sha: full, subject: 'feat: real subject' })).toBe(false);
    d = await getTaskDetail(db, a.id);
    expect(d?.links.map((l) => [l.ref, l.meta.subject])).toEqual([[full, 'feat: real subject']]);
    expect(d?.events.filter((e) => e.type === 'commit_linked')).toHaveLength(0);
    // full first, then a short one: nothing changes
    const b = await mk('Full then short');
    await startTask(ctx, { projectId: project.id, task: b.ref });
    expect(await linkCommit(ctx, { taskId: b.id, sha: full, subject: 'feat: kept' })).toBe(true);
    await completeTask(ctx, { projectId: project.id, task: b.ref, result: 'done', commits: ['abcdef1'] });
    expect(await linkCommit(ctx, { taskId: b.id, sha: 'abcdef12', subject: '' })).toBe(false);
    d = await getTaskDetail(db, b.id);
    expect(d?.links.map((l) => [l.ref, l.meta.subject])).toEqual([[full, 'feat: kept']]);
    expect(d?.events.filter((e) => e.type === 'commit_linked')).toHaveLength(1);
    // a short row with a subject keeps it when the full sha arrives without one
    const c = await mk('Subject kept');
    await startTask(ctx, { projectId: project.id, task: c.ref });
    expect(await linkCommit(ctx, { taskId: c.id, sha: 'abcdef1', subject: 'feat: short had it' })).toBe(true);
    expect(await linkCommit(ctx, { taskId: c.id, sha: full, subject: '' })).toBe(false);
    expect((await getTaskDetail(db, c.id))?.links.map((l) => [l.ref, l.meta.subject])).toEqual([[full, 'feat: short had it']]);
  });

  it('an amend removes the amended link by prefix, 4–6-char refs from task_complete included', async () => {
    const { ctx, project, mk } = await setup('git@github.com:me/l13.git');
    const old = 'beef1234567890abcdef1234567890abcdef1234';
    const t = await mk('Amend after a 4-char ref');
    await startTask(ctx, { projectId: project.id, task: t.ref });
    await completeTask(ctx, { projectId: project.id, task: t.ref, result: 'done', commits: ['BEEF'] });
    expect((await getTaskDetail(db, t.id))?.links.map((l) => l.ref)).toEqual(['BEEF']);
    const neu = '0'.repeat(40);
    expect(await linkCommit(ctx, { taskId: t.id, sha: neu, subject: 'fix', amends: old })).toBe(true);
    expect((await getTaskDetail(db, t.id))?.links.map((l) => l.ref)).toEqual([neu]);
  });

  it('linkCommit on an unknown task is not_found', async () => {
    const { ctx } = await setup('git@github.com:me/l9.git');
    await expect(linkCommit(ctx, { taskId: '00000000-0000-0000-0000-000000000000', sha: 'abc1234', subject: 's' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('janitorRelease and linkCommit', async () => {
    const { ctx, project, session, mk } = await setup('git@github.com:me/l4.git');
    const t = await mk('Long job');
    await startTask(ctx, { projectId: project.id, task: t.ref });
    expect(await linkCommit(ctx, { taskId: t.id, sha: 'f00ba12', subject: 'wip' })).toBe(true);
    expect(await linkCommit(ctx, { taskId: t.id, sha: 'f00ba12', subject: 'wip' })).toBe(false);
    await endSession(db, session.id, 'exit');
    const sys: Ctx = { db, actor: { kind: 'system' } };
    const rel = await janitorRelease(sys, { taskId: t.id, to: 'review', autoSummary: 'Автосводка (система): коммиты f00ba12', expectedSessionId: session.id });
    expect(rel?.task.status).toBe('review');
    expect(rel?.task.result).toContain('Автосводка');
    expect(await janitorRelease(sys, { taskId: t.id, to: 'todo', expectedSessionId: session.id })).toBeNull();
  });

  it('janitorRelease leaves a task whose session resumed after the janitor selected it', async () => {
    const { ctx, project, session, mk } = await setup('git@github.com:me/l10.git');
    const t = await mk('Resumed job');
    await startTask(ctx, { projectId: project.id, task: t.ref });
    // the janitor selected the task while the session was silent...
    await db.query(`UPDATE sessions SET state = 'stale' WHERE id = $1`, [session.id]);
    // ...then the session came back (events refresh the claim) before janitorRelease took the row lock
    await touchSession(db, session.id);
    const sys: Ctx = { db, actor: { kind: 'system' } };
    expect(await janitorRelease(sys, { taskId: t.id, to: 'todo', expectedSessionId: session.id })).toBeNull();
    const after = await getTaskById(db, t.id);
    expect(after?.status).toBe('in_progress');
    expect(after?.claimedBySessionId).toBe(session.id);
    // once the live claim has lapsed the same call releases it
    const later: Ctx = { db, actor: { kind: 'system' }, now: new Date(Date.now() + 31 * 60_000) };
    expect((await janitorRelease(later, { taskId: t.id, to: 'todo', expectedSessionId: session.id }))?.task.status).toBe('todo');
  });

  it('janitorRelease leaves a task that another session took over', async () => {
    const { ctx, project, session, agent, mk } = await setup('git@github.com:me/l11.git');
    const t = await mk('Taken over job');
    await startTask(ctx, { projectId: project.id, task: t.ref });
    await endSession(db, session.id, 'exit');
    const other = await seedSecondSession(db, agent.id, 'git@github.com:me/l11.git', 'takeover-ext');
    await startTask({ db, actor: other.actor }, { projectId: project.id, task: t.ref });
    const sys: Ctx = { db, actor: { kind: 'system' } };
    expect(await janitorRelease(sys, { taskId: t.id, to: 'todo', expectedSessionId: session.id })).toBeNull();
    const after = await getTaskById(db, t.id);
    expect(after?.status).toBe('in_progress');
    expect(after?.claimedBySessionId).toBe(other.session.id);
  });
});
