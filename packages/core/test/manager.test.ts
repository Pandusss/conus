import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../../../test/helpers/db';
import { seedAgentSession } from '../../../test/helpers/fixtures';
import type { Db } from '../src/db';
import { buildDigest, markNotified, notifiedUpTo, pendingNotices, renderNotice } from '../src/manager/digest';
import { INBOX_KEY, getIntakeBatch, runIntake } from '../src/manager/intake';
import { NullManagerLlm, renderIntakeInput, type IntakeResult, type ManagerLlm, type ReviewContext, type ReviewResult } from '../src/manager/llm';
import { latestReview, runReview } from '../src/manager/review';
import {
  createTelegramLinkCode, getSettings, inQuietHours, isTimeZone, linkTelegramChat, localClock, unlinkTelegram, updateSettings,
} from '../src/settings';
import { renderSessionContext } from '../src/snapshot';
import { createTask } from '../src/tasks/create';
import { blockTask, completeTask, startTask } from '../src/tasks/lifecycle';
import { managerSetPriority, ownerMoveTask, ownerSetPlanning } from '../src/tasks/owner-ops';
import { getTaskById, getTaskDetail } from '../src/tasks/queries';
import type { Ctx, Task } from '../src/types';

let db: Db; let drop: () => Promise<void>;
beforeAll(async () => ({ db, drop } = await createTestDb()));
afterAll(async () => drop());
const owner = (): Ctx => ({ db, actor: { kind: 'user' } });
const manager = (): Ctx => ({ db, actor: { kind: 'manager' } });

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

/** A model stand-in: returns what the test sets and records what it was asked. */
class FakeLlm implements ManagerLlm {
  readonly enabled = true;
  readonly model = 'fake-model';
  intake: IntakeResult = { summary: '', items: [] };
  reviewResult: ReviewResult = { summary: '', focus: [], priorities: [], findings: [] };
  asked: { text?: string; context?: unknown; review?: ReviewContext } = {};
  async extract(text: string, context: unknown) { this.asked = { text, context }; return this.intake; }
  async review(context: ReviewContext) { this.asked = { review: context }; return this.reviewResult; }
}
const item = (over: Partial<IntakeResult['items'][number]>): IntakeResult['items'][number] => ({
  project_key: null, title: 'Do something', description: '', type: 'task', priority: 'normal', due_on: null,
  source_quote: 'please do something', duplicate_of: null, requested_by: null, ...over,
});

describe('settings', () => {
  it('validates time zones and times; reads the wall clock in a zone', async () => {
    expect(isTimeZone('Europe/Moscow')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
    await expect(updateSettings(db, { timeZone: 'Mars/Olympus' })).rejects.toMatchObject({ code: 'validation' });
    await expect(updateSettings(db, { digestTime: '9:00' })).rejects.toMatchObject({ code: 'validation' });
    const s = await updateSettings(db, { timeZone: 'Europe/Moscow', digestTime: '08:30', managerAuto: true });
    expect(s).toMatchObject({ timeZone: 'Europe/Moscow', digestTime: '08:30', quietFrom: '22:00', quietTo: '08:00', notifyReview: true });
    // 2026-11-09 21:30 UTC is already the 10th, 00:30, in Moscow
    expect(localClock(new Date('2026-11-09T21:30:00Z'), 'Europe/Moscow')).toMatchObject({ date: '2026-11-10', time: '00:30' });
  });

  it('knows quiet hours, across midnight too', () => {
    expect(inQuietHours('23:10', '22:00', '08:00')).toBe(true);
    expect(inQuietHours('07:59', '22:00', '08:00')).toBe(true);
    expect(inQuietHours('08:00', '22:00', '08:00')).toBe(false);
    expect(inQuietHours('13:00', '12:00', '14:00')).toBe(true);
    expect(inQuietHours('13:00', '10:00', '10:00')).toBe(false);
  });

  it('links a Telegram chat with a one-time code that expires', async () => {
    const now = new Date('2026-11-09T10:00:00Z');
    const { code } = await createTelegramLinkCode(db, now);
    expect(await linkTelegramChat(db, { code: 'wrong-code-xxxxxxxx', chatId: 1, username: 'x' }, now)).toBe(false);
    expect(await linkTelegramChat(db, { code, chatId: 42, username: 'owner' }, new Date(now.getTime() + 16 * 60_000))).toBe(false);
    const fresh = await createTelegramLinkCode(db, now);
    expect(await linkTelegramChat(db, { code: fresh.code, chatId: 42, username: 'owner' }, now)).toBe(true);
    expect(await getSettings(db)).toMatchObject({ telegramChatId: 42, telegramUsername: 'owner' });
    expect(await linkTelegramChat(db, { code: fresh.code, chatId: 666, username: 'thief' }, now)).toBe(false); // used once
    await unlinkTelegram(db);
    expect((await getSettings(db)).telegramChatId).toBeNull();
  });
});

describe('manager task operations', () => {
  it('sets priorities with a reason, never over the owner, and only fills a missing date', async () => {
    const s = await seed('git@github.com:me/mgr-prio.git');
    const a = await s.mk('Manager may change me');
    const r = await managerSetPriority(manager(), { taskId: a.id, priority: 'high', dueOn: '2026-12-01', reason: 'client deadline' });
    expect(r).toMatchObject({ changed: true, pinned: false, task: { priority: 'high', prioritySource: 'manager', dueOn: '2026-12-01' } });
    const ev = (await getTaskDetail(db, a.id))!.events.at(-1)!;
    expect(ev).toMatchObject({ type: 'updated', actorKind: 'manager', reason: 'client deadline', changes: { priority: { from: 'normal', to: 'high' } } });
    // a date somebody set is kept
    const again = await managerSetPriority(manager(), { taskId: a.id, priority: 'high', dueOn: '2027-01-01', reason: 'x' });
    expect(again.changed).toBe(false);
    expect((await getTaskById(db, a.id))!.dueOn).toBe('2026-12-01');

    const b = await s.mk('Owner decided');
    await ownerSetPlanning(owner(), { taskId: b.id, priority: 'low' });
    const p = await managerSetPriority(manager(), { taskId: b.id, priority: 'urgent', reason: 'x' });
    expect(p).toMatchObject({ changed: false, pinned: true, task: { priority: 'low' } });
    await expect(managerSetPriority(owner(), { taskId: b.id, priority: 'urgent', reason: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('moves a task to another project with a new number, keeping the old ref in the history', async () => {
    const from = await seed('git@github.com:me/mv-from.git');
    const to = await seed('git@github.com:me/mv-to.git');
    const x = await from.mk('Filed in the wrong place');
    const r = await ownerMoveTask(owner(), { taskId: x.id, projectId: to.project.id });
    expect(r.task.projectId).toBe(to.project.id);
    expect(r.task.ref.startsWith(`${to.project.key}-`)).toBe(true);
    expect((await getTaskDetail(db, x.id))!.events.at(-1)).toMatchObject({ type: 'moved', changes: { ref: { from: x.ref, to: r.task.ref } } });
    // a task an agent holds stays put
    const busy = await from.mk('Being worked on');
    await startTask(from.ctx, { projectId: from.project.id, task: busy.ref });
    await expect(ownerMoveTask(owner(), { taskId: busy.id, projectId: to.project.id })).rejects.toMatchObject({ code: 'validation' });
    await expect(ownerMoveTask(manager(), { taskId: x.id, projectId: from.project.id })).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('intake', () => {
  it('files the work from correspondence as proposals in the right projects, with priority, date and quote', async () => {
    const web = await seed('git@github.com:me/in-web.git');
    const existing = await web.mk('Add CSV export to reports');
    const llm = new FakeLlm();
    llm.intake = {
      summary: 'The client wants two things.',
      items: [
        item({ project_key: web.project.key.toLowerCase(), title: 'Fix the login button on Safari', type: 'bug', priority: 'urgent', due_on: '2026-11-12', source_quote: 'login is broken on Safari!', requested_by: 'Anna' }),
        item({ project_key: web.project.key, title: 'CSV export for reports', duplicate_of: existing.ref }),
        item({ project_key: 'NOPE', title: 'Prepare the investor update' }),
      ],
    };
    const b = await runIntake({ db, llm }, { source: 'web', text: 'Anna: login is broken on Safari! Also CSV export please. Investor wants an update.' });
    expect(b).toMatchObject({ status: 'done', source: 'web', summary: 'The client wants two things.' });
    expect(b.tasks.map((x) => x.title)).toEqual(['Fix the login button on Safari', 'Prepare the investor update']);
    const [bug, update] = b.tasks;
    expect(bug).toMatchObject({ status: 'proposed', projectId: web.project.id, priority: 'urgent', prioritySource: 'manager', dueOn: '2026-11-12', sourceQuote: 'login is broken on Safari!' });
    expect(bug!.description).toContain('Anna');
    expect(update!.projectKey).toBe(INBOX_KEY); // no project fits
    expect(b.duplicates).toEqual([{ title: 'CSV export for reports', ref: existing.ref, existingTitle: existing.title }]);
    expect((await getTaskDetail(db, bug!.id))!.events[0]).toMatchObject({ type: 'proposed', actorKind: 'manager' });
    // the model saw the projects and their open tasks as data
    expect(renderIntakeInput('x', llm.asked.context as never)).toContain(existing.ref);
    expect((await getIntakeBatch(db, b.id))!.tasks).toHaveLength(2);
  });

  it('reports the Inbox only once, and turns trigram repeats into duplicates too', async () => {
    const llm = new FakeLlm();
    llm.intake = { summary: 's', items: [item({ title: 'Prepare the investor update' })] };
    const b = await runIntake({ db, llm }, { source: 'telegram', text: 'investor update again' });
    expect(b.tasks).toEqual([]);
    expect(b.duplicates[0]!.existingTitle).toBe('Prepare the investor update');
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM projects WHERE key = $1`, [INBOX_KEY]);
    expect(rows[0].n).toBe(1);
  });

  it('refuses empty and huge texts, and says when the manager has no model', async () => {
    const llm = new FakeLlm();
    await expect(runIntake({ db, llm }, { source: 'web', text: '   ' })).rejects.toMatchObject({ code: 'validation' });
    await expect(runIntake({ db, llm }, { source: 'web', text: 'x'.repeat(30_001) })).rejects.toMatchObject({ code: 'validation' });
    await expect(runIntake({ db, llm: new NullManagerLlm() }, { source: 'web', text: 'hi' })).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('keeps a failed run, so nothing the owner sent is lost', async () => {
    const llm = new FakeLlm();
    llm.extract = async () => { throw new Error('model down'); };
    await expect(runIntake({ db, llm }, { source: 'telegram', text: 'remember this' })).rejects.toThrow('model down');
    const { rows } = await db.query(`SELECT status, input, error FROM intake_batches ORDER BY id DESC LIMIT 1`);
    expect(rows[0]).toEqual({ status: 'failed', input: 'remember this', error: 'model down' });
  });
});

describe('review', () => {
  it('changes priorities the owner allows, keeps focus and findings, and agents see the focus', async () => {
    const s = await seed('git@github.com:me/rev.git', 'claude-code@rev');
    const a = await s.mk('Ship payments');
    const b = await s.mk('Owner pinned this');
    const c = await s.mk('Tidy the docs');
    await ownerSetPlanning(owner(), { taskId: b.id, priority: 'low' });
    await updateSettings(db, { managerAuto: true });
    const llm = new FakeLlm();
    llm.reviewResult = {
      summary: 'Payments first.',
      focus: [{ ref: a.ref, why: 'the client waits' }, { ref: 'GHOST-1', why: 'unknown ref is dropped' }],
      priorities: [
        { ref: a.ref, priority: 'urgent', reason: 'deadline' },
        { ref: b.ref, priority: 'urgent', reason: 'ignored: pinned' },
        { ref: c.ref, priority: 'normal', reason: 'already normal' },
      ],
      findings: [{ kind: 'unclear', refs: [c.ref, 'GHOST-2'], note: 'what docs?' }, { kind: 'stale', refs: ['GHOST-3'], note: 'dropped' }],
    };
    const r = await runReview({ db, llm }, 'owner');
    expect(r.summary).toBe('Payments first.');
    expect(r.focus).toEqual([{ taskId: a.id, ref: a.ref, title: a.title, why: 'the client waits' }]);
    expect(r.changes).toEqual([{ taskId: a.id, ref: a.ref, title: a.title, from: 'normal', to: 'urgent', reason: 'deadline', applied: true }]);
    expect(r.findings).toEqual([{ kind: 'unclear', refs: [c.ref], note: 'what docs?' }]);
    expect((await getTaskById(db, a.id))!.priority).toBe('urgent');
    expect((await getTaskById(db, b.id))!.priority).toBe('low');
    // the model was told which priorities are pinned
    expect(llm.asked.review!.tasks.find((x) => x.ref === b.ref)).toMatchObject({ pinned: true });
    expect((await latestReview(db))!.id).toBe(r.id);
    const text = await renderSessionContext(db, { session: s.session, project: s.project, agentName: 'a' });
    expect(text).toContain(`Manager's focus in this project today: ${a.ref} «Ship payments» — the client waits`);
  });

  it('only suggests when the owner turned automatic priorities off', async () => {
    const s = await seed('git@github.com:me/rev-off.git');
    const a = await s.mk('Suggest only');
    await updateSettings(db, { managerAuto: false });
    const llm = new FakeLlm();
    llm.reviewResult = { summary: 'x', focus: [], findings: [], priorities: [{ ref: a.ref, priority: 'high', reason: 'maybe' }] };
    const r = await runReview({ db, llm }, 'daily');
    expect(r.changes.find((c) => c.ref === a.ref)).toMatchObject({ applied: false, to: 'high' });
    expect((await getTaskById(db, a.id))!.priority).toBe('normal');
    await updateSettings(db, { managerAuto: true });
  });
});

describe('digest and notifications', () => {
  it('notifies once per task that went to review or got blocked and is still there', async () => {
    const s = await seed('git@github.com:me/notify.git');
    const start = await notifiedUpTo(db);
    const check = await s.mk('Check me');
    await startTask(s.ctx, { projectId: s.project.id, task: check.ref });
    await completeTask(s.ctx, { projectId: s.project.id, task: check.ref, result: 'Done <b>bold</b> & more', needsReview: true });
    const stuck = await s.mk('Stuck <script>');
    await blockTask(s.ctx, { projectId: s.project.id, task: stuck.ref, reason: 'no keys' });
    const unstuck = await s.mk('Unblocked later');
    await blockTask(s.ctx, { projectId: s.project.id, task: unstuck.ref, reason: 'x' });
    await startTask(s.ctx, { projectId: s.project.id, task: unstuck.ref });

    const { notices, lastId } = await pendingNotices(db, start);
    expect(notices.map((n) => [n.task.ref, n.kind])).toEqual([[check.ref, 'review'], [stuck.ref, 'blocked']]);
    const text = renderNotice(notices[0]!);
    expect(text).toContain('Done &lt;b&gt;bold&lt;/b&gt; &amp; more'); // escaped for Telegram HTML
    expect(renderNotice(notices[1]!)).toContain('Stuck &lt;script&gt;');
    await markNotified(db, lastId);
    expect((await pendingNotices(db, await notifiedUpTo(db))).notices).toEqual([]);
  });

  it('builds a digest with focus, what waits for the owner and the projects', async () => {
    const s = await seed('git@github.com:me/digest.git');
    const a = await s.mk('Focus on me');
    const llm = new FakeLlm();
    llm.reviewResult = { summary: 'All calm.', focus: [{ ref: a.ref, why: 'it matters' }], priorities: [], findings: [] };
    await runReview({ db, llm }, 'daily');
    const text = await buildDigest(db, 'https://conus.example.com', new Date());
    expect(text).toMatch(/^☀️ <b>Digest · \w+, \w+ \d+<\/b>\n<blockquote>All calm\.<\/blockquote>\n\n🎯 <b>Focus for today<\/b>\n/);
    expect(text).toContain(`1. <a href="https://conus.example.com/tasks/${a.id}">${a.ref}</a> Focus on me\n    <i>it matters</i>`);
    expect(text).toMatch(/👀 <b>To check · \d+<\/b>\n• <a href=/);
    expect(text).toMatch(/⛔ <b>Blocked · \d+<\/b>\n/);
    expect(text).toContain('<a href="https://conus.example.com/proposals">');
    expect(text).toContain('📊 <b>Projects</b>\n<blockquote');
    expect(text.length).toBeLessThanOrEqual(4000);
    // without an address that opens from a phone the refs are bold, and nothing links anywhere
    const local = await buildDigest(db, null, new Date());
    expect(local).toContain(`1. <b>${a.ref}</b> Focus on me`);
    expect(local).not.toContain('<a ');
  });
});
