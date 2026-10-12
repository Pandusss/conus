import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../../../test/helpers/db';
import { seedAgentSession, seedSecondSession } from '../../../test/helpers/fixtures';
import type { Db } from '../src/db';
import { EXCERPT_MAX, recordExcerpt, recordFacts } from '../src/activity';
import { DECISION_MARKERS, evaluateStop, NUDGE_LIMIT_PER_SESSION } from '../src/stop-check';
import { NullJudge, type Judge, type JudgeInput, type JudgeVerdict } from '../src/judge-types';
import { beginTurn, getSessionById } from '../src/sessions';
import { createTask, proposeTask } from '../src/tasks/create';
import { completeTask, updateTask } from '../src/tasks/lifecycle';
import { getTaskDetail } from '../src/tasks/queries';

let db: Db; let drop: () => Promise<void>;
beforeAll(async () => ({ db, drop } = await createTestDb()));
afterAll(async () => drop());

class FakeJudge implements Judge {
  enabled = true;
  calls: JudgeInput[] = [];
  constructor(private verdict: JudgeVerdict) {}
  async evaluate(i: JudgeInput) { this.calls.push(i); return this.verdict; }
  async summarize() { return null; }
}

const edit = (path: string) => ({ kind: 'file_edit' as const, data: { path } });
const commit = (sha: string) => ({ kind: 'git_commit' as const, data: { sha, subject: 'feat: x' } });

async function newTurn(sessionId: string) {
  await beginTurn(db, sessionId);
  return (await getSessionById(db, sessionId))!;
}

describe('decision markers', () => {
  it.each(['давай так и сделаем', 'ладно, экспорт не будем делать', 'Отменяем это', "let's do it", 'we won\'t ship that'])(
    'matches %s', (s) => expect(DECISION_MARKERS.test(s)).toBe(true),
  );
  it.each(['объясни как работает парсер', 'what does this function do?'])('ignores %s', (s) => expect(DECISION_MARKERS.test(s)).toBe(false));
});

describe('evaluateStop', () => {
  it('D1: 1–2 edits without commit → ok; ≥3 files → nudge once per file set', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/s1.git' });
    let session = await newTurn(s.session.id);
    await recordFacts(db, session.id, [edit('a.ts'), edit('b.ts')]);
    expect(await evaluateStop({ db, judge: new NullJudge() }, { session, stopHookActive: false })).toEqual({ action: 'ok' });
    session = await newTurn(session.id);
    await recordFacts(db, session.id, [edit('c.ts')]);
    const d = await evaluateStop({ db, judge: new NullJudge() }, { session, stopHookActive: false });
    expect(d.action).toBe('nudge');
    if (d.action === 'nudge') expect(d.reason).toContain('a.ts');
    // a turn with no edits/commits → not repeated
    session = await newTurn(session.id);
    expect(await evaluateStop({ db, judge: new NullJudge() }, { session, stopHookActive: false })).toEqual({ action: 'ok' });
    // one D1 per task-op epoch: a later turn adding a new file does NOT nudge again
    session = await newTurn(session.id);
    await recordFacts(db, session.id, [edit('d.ts')]);
    expect(await evaluateStop({ db, judge: new NullJudge() }, { session, stopHookActive: false })).toEqual({ action: 'ok' });
    // a task op starts a new epoch → a new D1 is possible again
    session = await newTurn(session.id);
    await recordFacts(db, session.id, [{ kind: 'task_op', data: { tool: 'task_create' } }]);
    expect(await evaluateStop({ db, judge: new NullJudge() }, { session, stopHookActive: false })).toEqual({ action: 'ok' });
    session = await newTurn(session.id);
    await recordFacts(db, session.id, [edit('e.ts'), edit('f.ts'), edit('g.ts')]);
    const d2 = await evaluateStop({ db, judge: new NullJudge() }, { session, stopHookActive: false });
    expect(d2.action).toBe('nudge');
    if (d2.action === 'nudge') expect(d2.reason).toContain('e.ts');
    const { rows } = await db.query('SELECT signature FROM nudges WHERE session_id = $1 ORDER BY id', [session.id]);
    expect(rows).toHaveLength(2);
    expect(rows[0].signature).not.toBe(rows[1].signature);
  });

  it('D1: needs an edit or commit in the current turn itself', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/s1b.git' });
    // ≥3 files accumulated (the hook-active pass never nudges), but the next turn has no edits → ok
    let session = await newTurn(s.session.id);
    await recordFacts(db, session.id, [edit('a.ts'), edit('b.ts'), edit('c.ts')]);
    expect(await evaluateStop({ db, judge: new NullJudge() }, { session, stopHookActive: true })).toEqual({ action: 'ok' });
    session = await newTurn(session.id);
    expect(await evaluateStop({ db, judge: new NullJudge() }, { session, stopHookActive: false })).toEqual({ action: 'ok' });
    // the first turn that actually edits something gets the (single) D1
    session = await newTurn(session.id);
    await recordFacts(db, session.id, [edit('d.ts')]);
    expect((await evaluateStop({ db, judge: new NullJudge() }, { session, stopHookActive: false })).action).toBe('nudge');
  });

  it('D1: a commit alone triggers; stop_hook_active always ok; task op clears D1', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/s2.git' });
    let session = await newTurn(s.session.id);
    await recordFacts(db, session.id, [commit('1111111')]);
    expect(await evaluateStop({ db, judge: new NullJudge() }, { session, stopHookActive: true })).toEqual({ action: 'ok' });
    expect((await evaluateStop({ db, judge: new NullJudge() }, { session, stopHookActive: false })).action).toBe('nudge');
    session = await newTurn(session.id);
    await recordFacts(db, session.id, [commit('2222222'), { kind: 'task_op', data: { tool: 'task_create' } }]);
    expect(await evaluateStop({ db, judge: new NullJudge() }, { session, stopHookActive: false })).toEqual({ action: 'ok' });
    const { rows } = await db.query('SELECT acted FROM nudges WHERE session_id = $1', [session.id]);
    expect(rows[0].acted).toBe(true);
  });

  it('D2: commit with a claimed task links it, no nudge, judge asked', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/s3.git' });
    const r = await createTask({ db, actor: s.actor }, { projectId: s.project.id, title: 'Linked work', startNow: true });
    if (r.outcome !== 'created') throw new Error();
    const session = await newTurn(s.session.id);
    await recordFacts(db, session.id, [commit('abcdef1')]);
    const judge = new FakeJudge({ verdict: 'ok', reason: '', taskRefs: [] });
    expect(await evaluateStop({ db, judge }, { session, stopHookActive: false, answerExcerpt: 'Готово, закоммитил.' })).toEqual({ action: 'ok' });
    const d = await getTaskDetail(db, r.task.id);
    expect(d?.links.map((l) => l.ref)).toEqual(['abcdef1']);
    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0]?.answer).toBe('Готово, закоммитил.');
    expect(judge.calls[0]?.sessionTasks.map((t) => t.ref)).toEqual([r.task.ref]);
  });

  it('D2 after closing: a commit following the task this session just completed is linked to it, no D1 nudge', async () => {
    // Live run (Task 21): "add --json" → task_complete (verified); next turn "commit it" → commit with no task in progress.
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/s3b.git' });
    const r = await createTask({ db, actor: s.actor }, { projectId: s.project.id, title: 'Флаг --json', startNow: true });
    if (r.outcome !== 'created') throw new Error();
    let session = await newTurn(s.session.id);
    await completeTask({ db, actor: s.actor }, { projectId: s.project.id, task: r.task.ref, result: 'Флаг добавлен, проверено вручную.' });
    await recordFacts(db, session.id, [edit('bin/greet.js'), { kind: 'task_op', data: { tool: 'task_complete', task: r.task.ref } }]);
    expect(await evaluateStop({ db, judge: new NullJudge() }, { session, stopHookActive: false })).toEqual({ action: 'ok' });
    session = await newTurn(session.id);
    await recordFacts(db, session.id, [commit('feed001')]);
    expect(await evaluateStop({ db, judge: new NullJudge() }, { session, stopHookActive: false })).toEqual({ action: 'ok' });
    const d = await getTaskDetail(db, r.task.id);
    expect(d?.task.status).toBe('done');
    expect(d?.links.map((l) => l.ref)).toEqual(['feed001']);
    expect(d?.events.at(-1)?.type).toBe('commit_linked');
    // a note on the closed task keeps it the session's latest task: the next commit is linked too
    await updateTask({ db, actor: s.actor }, { projectId: s.project.id, task: r.task.ref, note: 'README поправлен' });
    session = await newTurn(session.id);
    await recordFacts(db, session.id, [commit('feed002')]);
    expect(await evaluateStop({ db, judge: new NullJudge() }, { session, stopHookActive: false })).toEqual({ action: 'ok' });
    expect((await getTaskDetail(db, r.task.id))?.links.map((l) => l.ref).sort()).toEqual(['feed001', 'feed002']);
    const { rows } = await db.query('SELECT count(*)::int AS n FROM nudges WHERE session_id = $1', [session.id]);
    expect(rows[0].n).toBe(0);
  });

  it('D2 after closing applies only when closing that task was the latest task operation of the same session', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/s3c.git' });
    const a = await createTask({ db, actor: s.actor }, { projectId: s.project.id, title: 'Импорт CSV', startNow: true });
    if (a.outcome !== 'created') throw new Error();
    await completeTask({ db, actor: s.actor }, { projectId: s.project.id, task: a.task.ref, result: 'Готово.' });
    // the session's latest task operation is a proposal of other work → the commit is not the closed task's
    await proposeTask({ db, actor: s.actor }, { projectId: s.project.id, title: 'Когда-нибудь: кэш', sourceQuote: 'надо бы кэш' });
    let session = await newTurn(s.session.id);
    await recordFacts(db, session.id, [commit('beef001')]);
    expect((await evaluateStop({ db, judge: new NullJudge() }, { session, stopHookActive: false })).action).toBe('nudge');
    expect((await getTaskDetail(db, a.task.id))?.links).toEqual([]);

    // closed by another session → not this session's to link
    const s2 = await seedAgentSession(db, { remote: 'git@github.com:me/s3d.git' });
    const b = await createTask({ db, actor: s2.actor }, { projectId: s2.project.id, title: 'Экспорт', startNow: true });
    if (b.outcome !== 'created') throw new Error();
    const other = await seedSecondSession(db, s2.agent.id, 'git@github.com:me/s3d.git', 'ext-other-s3d');
    await completeTask({ db, actor: other.actor }, { projectId: s2.project.id, task: b.task.ref, result: 'Готово.' });
    session = await newTurn(other.session.id);
    await recordFacts(db, session.id, [commit('beef002')]);
    await evaluateStop({ db, judge: new NullJudge() }, { session, stopHookActive: false });
    expect((await getTaskDetail(db, b.task.id))?.links.map((l) => l.ref)).toEqual(['beef002']);
    session = await newTurn(s2.session.id);
    await recordFacts(db, session.id, [commit('beef003')]);
    expect((await evaluateStop({ db, judge: new NullJudge() }, { session, stopHookActive: false })).action).toBe('nudge');
    expect((await getTaskDetail(db, b.task.id))?.links.map((l) => l.ref)).toEqual(['beef002']);
  });

  it('D2 after closing has a limit: ≥3 files edited since the close → D1 nudge, the commit is not the closed task\'s', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/s3f.git' });
    const a = await createTask({ db, actor: s.actor }, { projectId: s.project.id, title: 'Фича A', startNow: true });
    if (a.outcome !== 'created') throw new Error();
    let session = await newTurn(s.session.id);
    await completeTask({ db, actor: s.actor }, { projectId: s.project.id, task: a.task.ref, result: 'Готово.' });
    await recordFacts(db, session.id, [{ kind: 'task_op', data: { tool: 'task_complete', task: a.task.ref } }]);
    await evaluateStop({ db, judge: new NullJudge() }, { session, stopHookActive: false });
    // an unrelated feature B built without a task: 3 files + commit
    session = await newTurn(session.id);
    await recordFacts(db, session.id, [edit('b1.ts'), edit('b2.ts'), edit('b3.ts'), commit('bbbb001')]);
    const d = await evaluateStop({ db, judge: new NullJudge() }, { session, stopHookActive: false });
    expect(d.action).toBe('nudge');
    if (d.action === 'nudge') expect(d.reason).toContain('b1.ts');
    expect((await getTaskDetail(db, a.task.id))?.links).toEqual([]);
  });

  it('D2 after closing: 1–2 files since the close still count as the closed task\'s commit', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/s3g.git' });
    const a = await createTask({ db, actor: s.actor }, { projectId: s.project.id, title: 'Фича A', startNow: true });
    if (a.outcome !== 'created') throw new Error();
    let session = await newTurn(s.session.id);
    await completeTask({ db, actor: s.actor }, { projectId: s.project.id, task: a.task.ref, result: 'Готово.' });
    await recordFacts(db, session.id, [{ kind: 'task_op', data: { tool: 'task_complete', task: a.task.ref } }]);
    session = await newTurn(session.id);
    await recordFacts(db, session.id, [edit('README.md'), edit('CHANGELOG.md'), commit('aaaa001')]);
    expect(await evaluateStop({ db, judge: new NullJudge() }, { session, stopHookActive: false })).toEqual({ action: 'ok' });
    expect((await getTaskDetail(db, a.task.id))?.links.map((l) => l.ref)).toEqual(['aaaa001']);
  });

  it('D2 after closing: needs_review (sent_to_review) counts as closing', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/s3h.git' });
    const a = await createTask({ db, actor: s.actor }, { projectId: s.project.id, title: 'Фича на проверку', startNow: true });
    if (a.outcome !== 'created') throw new Error();
    let session = await newTurn(s.session.id);
    await completeTask({ db, actor: s.actor }, { projectId: s.project.id, task: a.task.ref, result: 'Готово, проверь.', needsReview: true });
    await recordFacts(db, session.id, [{ kind: 'task_op', data: { tool: 'task_complete', task: a.task.ref } }]);
    session = await newTurn(session.id);
    await recordFacts(db, session.id, [commit('cccc001')]);
    expect(await evaluateStop({ db, judge: new NullJudge() }, { session, stopHookActive: false })).toEqual({ action: 'ok' });
    const d = await getTaskDetail(db, a.task.id);
    expect(d?.task.status).toBe('review');
    expect(d?.links.map((l) => l.ref)).toEqual(['cccc001']);
  });

  it('D2 after closing: a commit made earlier in the same turn, then task_complete → linked', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/s3i.git' });
    const a = await createTask({ db, actor: s.actor }, { projectId: s.project.id, title: 'Фича в одном ходе', startNow: true });
    if (a.outcome !== 'created') throw new Error();
    const session = await newTurn(s.session.id);
    await recordFacts(db, session.id, [edit('a.ts'), edit('b.ts'), edit('c.ts'), commit('dddd001')]);
    await completeTask({ db, actor: s.actor }, { projectId: s.project.id, task: a.task.ref, result: 'Готово.' });
    await recordFacts(db, session.id, [{ kind: 'task_op', data: { tool: 'task_complete', task: a.task.ref } }]);
    expect(await evaluateStop({ db, judge: new NullJudge() }, { session, stopHookActive: false })).toEqual({ action: 'ok' });
    expect((await getTaskDetail(db, a.task.id))?.links.map((l) => l.ref)).toEqual(['dddd001']);
  });

  it('D2 after closing: a task closed in another project is never the target', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/s3j.git' });
    const other = await seedAgentSession(db, { remote: 'git@github.com:me/s3j-other.git' });
    // this session closes a task of another project (explicit project argument)
    const a = await createTask({ db, actor: s.actor }, { projectId: other.project.id, title: 'Чужая задача', startNow: true });
    if (a.outcome !== 'created') throw new Error();
    let session = await newTurn(s.session.id);
    await completeTask({ db, actor: s.actor }, { projectId: other.project.id, task: a.task.ref, result: 'Готово.' });
    await recordFacts(db, session.id, [{ kind: 'task_op', data: { tool: 'task_complete', task: a.task.ref } }]);
    session = await newTurn(session.id);
    await recordFacts(db, session.id, [commit('eeee001')]);
    expect((await evaluateStop({ db, judge: new NullJudge() }, { session, stopHookActive: false })).action).toBe('nudge');
    expect((await getTaskDetail(db, a.task.id))?.links).toEqual([]);
  });

  it('D2 with an amend: the amended commit\'s link is replaced, its event stays in the history', async () => {
    // Live run (Task 21): commit 49725c5 with a broken message, then `git commit --amend` → 216eac2; both were linked.
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/s3k.git' });
    const a = await createTask({ db, actor: s.actor }, { projectId: s.project.id, title: 'Фича с amend', startNow: true });
    if (a.outcome !== 'created') throw new Error();
    let session = await newTurn(s.session.id);
    const first = '49725c5d03284fbcbb02dc52ebc461c14e9fcf37';
    const second = '216eac2c92b5f78534f4e8ae37ec0290d83e2066';
    await recordFacts(db, session.id, [
      { kind: 'git_commit', data: { sha: first, subject: '@ Add --json flag' } },
      { kind: 'git_commit', data: { sha: second, subject: 'Add --json flag', amends: first } },
    ]);
    expect(await evaluateStop({ db, judge: new NullJudge() }, { session, stopHookActive: false })).toEqual({ action: 'ok' });
    let d = await getTaskDetail(db, a.task.id);
    expect(d?.links.map((l) => l.ref)).toEqual([second]);
    expect(d?.events.filter((e) => e.type === 'commit_linked').map((e) => e.note)).toEqual(['49725c5 @ Add --json flag', '216eac2 Add --json flag']);
    // an amend in a later turn (task still in progress) replaces the link too
    session = await newTurn(session.id);
    const third = 'aaaa0000aaaa0000aaaa0000aaaa0000aaaa0000';
    await recordFacts(db, session.id, [{ kind: 'git_commit', data: { sha: third, subject: 'Add --json flag', amends: second } }]);
    await evaluateStop({ db, judge: new NullJudge() }, { session, stopHookActive: false });
    d = await getTaskDetail(db, a.task.id);
    expect(d?.links.map((l) => l.ref)).toEqual([third]);
  });

  it('the same commit recorded twice in a session (Stop fact + late PostToolUse, replay, short sha) is one fact', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/s3l.git' });
    const full = 'abcdef0'.padEnd(40, '1');
    let session = await newTurn(s.session.id);
    await recordFacts(db, session.id, [{ kind: 'git_commit', data: { sha: full, subject: 'x' } }]);
    await recordFacts(db, session.id, [{ kind: 'git_commit', data: { sha: full.toUpperCase(), subject: 'x' } }]);
    session = await newTurn(session.id);
    await recordFacts(db, session.id, [{ kind: 'git_commit', data: { sha: full.slice(0, 7), subject: 'x' } }, edit('a.ts')]);
    const rows = async (sid: string) => (await db.query(`SELECT turn, data->>'sha' AS sha FROM session_activity WHERE session_id = $1 AND kind = 'git_commit'`, [sid])).rows;
    expect(await rows(session.id)).toEqual([{ turn: 1, sha: full }]);
    // another session may report the same commit (it is that session's work too)
    const other = await seedSecondSession(db, s.agent.id, 'git@github.com:me/s3l.git', 'ext-other-s3l');
    await recordFacts(db, other.session.id, [{ kind: 'git_commit', data: { sha: full, subject: 'x' } }]);
    expect(await rows(other.session.id)).toHaveLength(1);
  });

  it('a commit already linked to a task is never "unlinked work" for D1 and is not linked to a second task', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/s3m.git' });
    const a = await createTask({ db, actor: s.actor }, { projectId: s.project.id, title: 'Задача A', startNow: true });
    if (a.outcome !== 'created') throw new Error();
    const full = 'beadfee'.padEnd(40, '2');
    // the agent names the commit itself (short sha) when closing A from another session
    const other = await seedSecondSession(db, s.agent.id, 'git@github.com:me/s3m.git', 'ext-other-s3m');
    await completeTask({ db, actor: other.actor }, { projectId: s.project.id, task: a.task.ref, result: 'Готово.', commits: [full.slice(0, 7)] });
    // no task in progress, nothing just closed by this session: the linked commit alone is not D1 material
    let session = await newTurn(s.session.id);
    await recordFacts(db, session.id, [{ kind: 'git_commit', data: { sha: full, subject: 'x' } }]);
    expect(await evaluateStop({ db, judge: new NullJudge() }, { session, stopHookActive: false })).toEqual({ action: 'ok' });
    // with another task in progress it is not linked there either
    const b = await createTask({ db, actor: s.actor }, { projectId: s.project.id, title: 'Совсем другая задача B', startNow: true, confirmNew: { reason: 't' } });
    if (b.outcome !== 'created') throw new Error();
    const s2 = await seedAgentSession(db, { remote: 'git@github.com:me/s3m.git' });
    const c = await createTask({ db, actor: s2.actor }, { projectId: s.project.id, title: 'Третья задача C', startNow: true, confirmNew: { reason: 't' } });
    if (c.outcome !== 'created') throw new Error();
    session = await newTurn(s2.session.id);
    await recordFacts(db, session.id, [{ kind: 'git_commit', data: { sha: full, subject: 'x' } }]);
    await evaluateStop({ db, judge: new NullJudge() }, { session, stopHookActive: false });
    expect((await getTaskDetail(db, c.task.id))?.links).toEqual([]);
    expect((await getTaskDetail(db, a.task.id))?.links.map((l) => l.ref)).toEqual([full.slice(0, 7)]);
    const { rows } = await db.query('SELECT count(*)::int AS n FROM nudges WHERE session_id = ANY($1)', [[s.session.id, s2.session.id]]);
    expect(rows[0].n).toBe(0);
  });

  it('D1 reason starts with a capital letter and lets the agent finish without talking about tasks', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/s3e.git' });
    const session = await newTurn(s.session.id);
    await recordFacts(db, session.id, [commit('ab12cd3')]);
    const d = await evaluateStop({ db, judge: new NullJudge() }, { session, stopHookActive: false });
    expect(d.action).toBe('nudge');
    if (d.action !== 'nudge') return;
    expect(d.reason).toMatch(/^Commit ab12cd3 made, but the work is not linked to a Conus task\./);
    expect(d.reason).toContain('If it is a small thing, just finish your reply without mentioning tasks.');
  });

  it('judge nudge is issued once per task set and carries the escape hatch', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/s4.git' });
    const r = await createTask({ db, actor: s.actor }, { projectId: s.project.id, title: 'Export', startNow: true });
    if (r.outcome !== 'created') throw new Error();
    const judge = new FakeJudge({ verdict: 'nudge', reason: `Похоже, ${r.task.ref} завершена — закрой её с итогом.`, taskRefs: [r.task.ref] });
    let session = await newTurn(s.session.id);
    await recordFacts(db, session.id, [{ kind: 'test_run', data: { passed: true, command: 'npm test' } }]);
    const d = await evaluateStop({ db, judge }, { session, stopHookActive: false });
    expect(d.action).toBe('nudge');
    if (d.action === 'nudge') expect(d.reason).toMatch(/just finish your reply/);
    session = await newTurn(session.id);
    await recordFacts(db, session.id, [{ kind: 'test_run', data: { passed: true, command: 'npm test' } }]);
    expect(await evaluateStop({ db, judge }, { session, stopHookActive: false })).toEqual({ action: 'ok' });
  });

  it('a long judge reason reaches the agent capped at 400 chars, without a split surrogate pair, escape hatch kept', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/s4b.git' });
    const r = await createTask({ db, actor: s.actor }, { projectId: s.project.id, title: 'Long reason', startNow: true });
    if (r.outcome !== 'created') throw new Error();
    // put an emoji right across every possible cut
    const judge = new FakeJudge({ verdict: 'nudge', reason: '😀'.repeat(600), taskRefs: [r.task.ref] });
    const session = await newTurn(s.session.id);
    await recordFacts(db, session.id, [{ kind: 'test_run', data: { passed: true, command: 'npm test' } }]);
    const d = await evaluateStop({ db, judge }, { session, stopHookActive: false });
    expect(d.action).toBe('nudge');
    if (d.action !== 'nudge') return;
    expect(d.reason.length).toBeLessThanOrEqual(400);
    expect(d.reason).toMatch(/If everything is up to date, just finish your reply without mentioning tasks\.$/);
    expect(d.reason).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(d.reason).toContain('…');
    const { rows } = await db.query(`SELECT reason FROM nudges WHERE session_id = $1`, [session.id]);
    expect(rows[0].reason).toBe(d.reason);
  });

  it('judge is asked on Russian decision markers in the prompt', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/s5.git' });
    const session = await newTurn(s.session.id);
    await recordExcerpt(db, session.id, 'prompt_excerpt', 'ладно, экспорт не будем делать');
    const judge = new FakeJudge({ verdict: 'ok', reason: '', taskRefs: [] });
    await evaluateStop({ db, judge }, { session, stopHookActive: false });
    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0]?.prompt).toBe('ладно, экспорт не будем делать');
  });

  it(`stops nudging after ${NUDGE_LIMIT_PER_SESSION} nudges`, async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/s6.git' });
    let session = s.session;
    // each task-op turn opens a new D1 epoch, the following commit turn nudges once in it
    for (let i = 0; i < NUDGE_LIMIT_PER_SESSION + 2; i++) {
      session = await newTurn(session.id);
      await recordFacts(db, session.id, [{ kind: 'task_op', data: { tool: 'task_create' } }]);
      await evaluateStop({ db, judge: new NullJudge() }, { session, stopHookActive: false });
      session = await newTurn(session.id);
      await recordFacts(db, session.id, [commit(`c${i}`.padEnd(7, '0'))]);
      await evaluateStop({ db, judge: new NullJudge() }, { session, stopHookActive: false });
    }
    const { rows } = await db.query('SELECT count(*)::int AS n FROM nudges WHERE session_id = $1', [session.id]);
    expect(rows[0].n).toBe(NUDGE_LIMIT_PER_SESSION);
  });

  it('D2 is not gated by nudging: links commits at the nudge cap and under stop_hook_active', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/s7.git' });
    const r = await createTask({ db, actor: s.actor }, { projectId: s.project.id, title: 'Capped work', startNow: true });
    if (r.outcome !== 'created') throw new Error();
    await db.query(
      `INSERT INTO nudges(session_id, turn, rule, reason, task_refs, signature)
       SELECT $1, 1, 'D1', 'seed', '{}', 'seed-' || g FROM generate_series(1, $2::int) g`,
      [s.session.id, NUDGE_LIMIT_PER_SESSION],
    );
    const session = await newTurn(s.session.id);
    await recordFacts(db, session.id, [commit('cafe001')]);
    expect(await evaluateStop({ db, judge: new NullJudge() }, { session, stopHookActive: false })).toEqual({ action: 'ok' });
    expect((await getTaskDetail(db, r.task.id))?.links.map((l) => l.ref)).toEqual(['cafe001']);

    const s2 = await seedAgentSession(db, { remote: 'git@github.com:me/s8.git' });
    const r2 = await createTask({ db, actor: s2.actor }, { projectId: s2.project.id, title: 'Hook active work', startNow: true });
    if (r2.outcome !== 'created') throw new Error();
    const session2 = await newTurn(s2.session.id);
    await recordFacts(db, session2.id, [commit('cafe002')]);
    expect(await evaluateStop({ db, judge: new NullJudge() }, { session: session2, stopHookActive: true })).toEqual({ action: 'ok' });
    expect((await getTaskDetail(db, r2.task.id))?.links.map((l) => l.ref)).toEqual(['cafe002']);
  });

  it('a deduplicated D1 falls through to the judge triggers', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/s9.git' });
    const judge = new FakeJudge({ verdict: 'ok', reason: '', taskRefs: [] });
    let session = await newTurn(s.session.id);
    await recordFacts(db, session.id, [commit('d1d1d11')]);
    expect((await evaluateStop({ db, judge }, { session, stopHookActive: false })).action).toBe('nudge');
    expect(judge.calls).toHaveLength(0);
    // same epoch: D1 is a duplicate, but a decision marker in the prompt still reaches the judge
    session = await newTurn(session.id);
    await recordFacts(db, session.id, [commit('d1d1d12')]);
    await recordExcerpt(db, session.id, 'prompt_excerpt', 'ладно, это не будем делать');
    expect(await evaluateStop({ db, judge }, { session, stopHookActive: false })).toEqual({ action: 'ok' });
    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0]?.prompt).toBe('ладно, это не будем делать');
  });

  it('a failing judge means ok, never an exception', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/s10.git' });
    let calls = 0;
    const judge: Judge = {
      enabled: true,
      async evaluate() { calls++; throw new Error('boom'); },
      async summarize() { return null; },
    };
    const session = await newTurn(s.session.id);
    await recordExcerpt(db, session.id, 'prompt_excerpt', 'давай так и сделаем');
    expect(await evaluateStop({ db, judge }, { session, stopHookActive: false })).toEqual({ action: 'ok' });
    expect(calls).toBe(1);
  });
});

describe('recordExcerpt', () => {
  const stored = async (sessionId: string) => {
    const { rows } = await db.query(`SELECT data->>'text' AS text FROM session_activity WHERE session_id = $1 AND kind = 'answer_excerpt'`, [sessionId]);
    return rows.map((r) => r.text as string);
  };

  it('does not split a surrogate pair when truncating', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/s11.git' });
    const session = await newTurn(s.session.id);
    await recordExcerpt(db, session.id, 'answer_excerpt', 'a'.repeat(1999) + '😀');
    const [text] = await stored(session.id);
    expect(text).toBe('a'.repeat(1999));
    expect(text!.length).toBeLessThanOrEqual(EXCERPT_MAX);
  });

  it('keeps an emoji that fits exactly, and truncates plain text to EXCERPT_MAX', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/s12.git' });
    let session = await newTurn(s.session.id);
    await recordExcerpt(db, session.id, 'answer_excerpt', 'a'.repeat(1998) + '😀');
    expect((await stored(session.id))[0]).toBe('a'.repeat(1998) + '😀');
    session = await newTurn(session.id);
    await recordExcerpt(db, session.id, 'answer_excerpt', 'б'.repeat(EXCERPT_MAX + 50));
    expect((await stored(session.id))[1]).toBe('б'.repeat(EXCERPT_MAX));
  });
});
