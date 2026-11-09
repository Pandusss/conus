import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../../../test/helpers/db';
import { seedAgentSession } from '../../../test/helpers/fixtures';
import type { Db } from '../src/db';
import { buildNow, pendingNotices, renderNoticeBurst, renderReview } from '../src/manager/digest';
import {
  dueWords, esc, fit, fitted, link, linkBase, pack, plainText, quote, section, taskLink, visibleLength, waitedWords,
} from '../src/manager/format';
import { runIntake } from '../src/manager/intake';
import type { IntakeResult, ManagerLlm, ReviewResult } from '../src/manager/llm';
import { runReview } from '../src/manager/review';
import { localClock, updateSettings } from '../src/settings';
import { createTask } from '../src/tasks/create';
import { blockTask, completeTask, startTask } from '../src/tasks/lifecycle';
import { ownerSetPlanning } from '../src/tasks/owner-ops';
import type { Ctx, Task } from '../src/types';

const BASE = 'https://conus.example.com';

class FakeLlm implements ManagerLlm {
  readonly enabled = true;
  readonly model = 'fake-model';
  intake: IntakeResult = { summary: '', items: [] };
  reviewResult: ReviewResult = { summary: '', focus: [], priorities: [], findings: [] };
  async extract() { return this.intake; }
  async review() { return this.reviewResult; }
}

describe('the layout of a message', () => {
  it('escapes what Telegram reads as markup, and reads the text back', () => {
    expect(esc('a < b && c > d "q"')).toBe('a &lt; b &amp;&amp; c &gt; d "q"');
    const html = `<b>${esc('1 < 2 & 3')}</b> ${link('https://x.example/?a="1"&b=2', 'open')}`;
    expect(html).toBe('<b>1 &lt; 2 &amp; 3</b> <a href="https://x.example/?a=&quot;1&quot;&amp;b=2">open</a>');
    expect(plainText(html)).toBe('1 < 2 & 3 open');
    expect(visibleLength(html)).toBe(14);
  });

  it('links to the web app only when the link would open from a phone', () => {
    expect(linkBase('https://conus.example.com/')).toBe('https://conus.example.com');
    for (const local of [null, undefined, '', 'http://conus.example.com', 'https://localhost:8787', 'https://127.0.0.1', 'https://[::1]:8787']) {
      expect(linkBase(local), String(local)).toBeNull();
    }
    const task = { id: 'a1', ref: 'CON-7' };
    expect(taskLink(task, BASE)).toBe('<a href="https://conus.example.com/tasks/a1">CON-7</a>');
    expect(taskLink(task, null)).toBe('<b>CON-7</b>');
  });

  it('folds a long quote and says how many lines a section leaves out', () => {
    expect(quote('short')).toBe('<blockquote>short</blockquote>');
    expect(quote('x'.repeat(321))).toMatch(/^<blockquote expandable>/);
    expect(quote('1\n2\n3\n4\n5\n6')).toMatch(/^<blockquote expandable>/);
    expect(section('<b>Head</b>', ['• one', '• two'], 3)).toBe('<b>Head</b>\n• one\n• two\n…and 3 more');
    expect(section('<b>Head</b>', ['• one'])).toBe('<b>Head</b>\n• one');
  });

  it('cuts a long message by whole sections, never inside a tag', () => {
    const sections = ['<b>First</b>', `<i>${'s'.repeat(40)}</i>`, `<b>${'t'.repeat(40)}</b>`];
    expect(fit(sections, 200)).toBe(sections.join('\n\n'));
    expect(fitted(sections, 60)).toEqual({ text: `<b>First</b>\n\n<i>${'s'.repeat(40)}</i>\n\n…`, kept: 2 });
    expect(fitted(sections, 20)).toEqual({ text: '<b>First</b>\n\n…', kept: 1 });
    // one section that is too long by itself loses its markup rather than half of a tag
    const lone = fitted([`<b>${esc('я < ты '.repeat(20))}</b>`], 30);
    expect(lone.kept).toBe(0);
    expect(lone.text).not.toMatch(/<\/?b>/);
    expect(plainText(lone.text).length).toBeLessThanOrEqual(30);
    expect(lone.text).toContain('&lt;');
    // too many formatted pieces for one message: Telegram would drop the formatting of the last ones
    const many = Array.from({ length: 60 }, (_, i) => `<b>${i}</b> <i>x</i>`);
    expect(fitted(many, 4000).kept).toBeLessThan(60);
    expect(fit(['', '<b>a</b>', ''])).toBe('<b>a</b>');
  });

  it('spreads sections over several messages when one cannot hold them', () => {
    const sections = Array.from({ length: 5 }, (_, i) => `<b>${String(i).repeat(30)}</b>`);
    const messages = pack(sections, 70);
    expect(messages).toEqual([`${sections[0]}\n\n${sections[1]}`, `${sections[2]}\n\n${sections[3]}`, sections[4]]);
    expect(pack(sections, 4000)).toEqual([sections.join('\n\n')]);
    expect(pack([], 100)).toEqual([]);
  });

  it('says a deadline and a wait in plain words', () => {
    expect(dueWords('2026-11-09', '2026-11-09')).toBe('due today');
    expect(dueWords('2026-11-10', '2026-11-09')).toBe('due tomorrow');
    expect(dueWords('2026-11-14', '2026-11-09')).toBe('due in 5 days');
    expect(dueWords('2026-11-08', '2026-11-09')).toBe('overdue by 1 day');
    expect(dueWords('2026-10-30', '2026-11-09')).toBe('overdue by 10 days');
    const now = new Date('2026-11-09T12:00:00Z');
    const ago = (h: number) => new Date(now.getTime() - h * 3_600_000);
    expect(waitedWords(ago(0.5), now)).toBe('');
    expect(waitedWords(ago(5.2), now)).toBe('waiting 5 h');
    expect(waitedWords(ago(30), now)).toBe('waiting 1 day');
    expect(waitedWords(ago(75), now)).toBe('waiting 3 days');
  });
});

describe('what waits for the owner now', () => {
  let db: Db; let drop: () => Promise<void>;
  beforeAll(async () => ({ db, drop } = await createTestDb()));
  afterAll(async () => drop());
  const owner = (): Ctx => ({ db, actor: { kind: 'user' } });

  it('goes from «nothing» through the focus and the proposals to a list of what waits', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/now.git' });
    const ctx = { db, actor: s.actor };
    const mk = async (title: string): Promise<Task> => {
      const r = await createTask(ctx, { projectId: s.project.id, title, confirmNew: { reason: 't' } });
      if (r.outcome !== 'created') throw new Error('not created');
      return r.task;
    };
    const llm = new FakeLlm();
    // the task timestamps are the database's own, so «now» is the real one
    const now = () => buildNow(db, BASE, new Date(), 'ask');

    expect(await now()).toEqual({ text: '✅ <b>Nothing waits for you right now.</b>', empty: true });

    // only the day's focus is left
    const main = await mk('Ship the importer');
    llm.reviewResult = { summary: 'One thing today.', focus: [{ ref: main.ref, why: 'the release waits for it' }], priorities: [], findings: [] };
    await runReview({ db, llm }, 'daily');
    const ref = `<a href="${BASE}/tasks/${main.id}">${main.ref}</a>`;
    expect(await now()).toEqual({ text: `📌 <b>Focus for today: 1 of 1 left</b>\n• ${ref} Ship the importer · <i>not started</i>`, empty: false });
    await startTask(ctx, { projectId: s.project.id, task: main.ref });
    expect((await buildNow(db, BASE, new Date(), 'reminder')).text).toBe(`⏰ <b>Focus for today: 1 of 1 left</b>\n• ${ref} Ship the importer · <i>in progress</i>`);

    // proposals from the correspondence come first when no task waits
    llm.intake = {
      summary: 'Two asks.',
      items: ['Send the invoice', 'Call the client'].map((title) => ({
        project_key: s.project.key, title, description: '', type: 'task' as const, priority: 'normal' as const, due_on: null,
        source_quote: title, duplicate_of: null, requested_by: null,
      })),
    };
    await runIntake({ db, llm }, { source: 'web', text: 'Client: send the invoice and call me' });
    expect((await now()).text).toBe([
      `📌 <b><a href="${BASE}/proposals">2 proposals</a> wait for your decision</b>`,
      `🎯 <b>Focus for today · 1 of 1 left</b>\n• ${ref} Ship the importer · <i>in progress</i>`,
    ].join('\n\n'));
    expect((await buildNow(db, null, new Date())).text).toContain('📌 <b>2 proposals wait for your decision</b>');

    // a check, a blocker and a deadline: three tasks wait
    await completeTask(ctx, { projectId: s.project.id, task: main.ref, result: 'Importer shipped.', needsReview: true });
    const stuck = await mk('Rotate the keys');
    await blockTask(ctx, { projectId: s.project.id, task: stuck.ref, reason: 'no access to the vault' });
    const today = localClock(new Date(), 'UTC').date;
    const dueToday = await mk('Pay the hosting bill');
    await ownerSetPlanning(owner(), { taskId: dueToday.id, dueOn: today });
    const later = await mk('Renew the domain');
    await ownerSetPlanning(owner(), { taskId: later.id, dueOn: '2099-01-01' }); // not due yet: it does not wait
    await ownerSetPlanning(owner(), { taskId: stuck.id, dueOn: today }); // already listed as blocked: counted once
    const v = await buildNow(db, BASE, new Date(), 'reminder');
    expect(v.empty).toBe(false);
    expect(v.text).toBe([
      '⏰ <b>3 tasks wait for you</b>',
      `👀 <b>To check · 1</b>\n• ${ref} Ship the importer`,
      `⛔ <b>Blocked · 1</b>\n• <a href="${BASE}/tasks/${stuck.id}">${stuck.ref}</a> Rotate the keys\n    <i>no access to the vault</i>`,
      `📅 <b>Deadlines</b>\n• <a href="${BASE}/tasks/${dueToday.id}">${dueToday.ref}</a> Pay the hosting bill · <i>due today</i>`,
      `📥 <a href="${BASE}/proposals">2 proposals</a> wait for your decision`,
      `🎯 <b>Focus for today · 1 of 1 left</b>\n• ${ref} Ship the importer · <i>to check</i>`,
    ].join('\n\n'));

    // many notices at once are one message, a section per kind
    const { notices } = await pendingNotices(db, 0);
    expect(renderNoticeBurst(notices, BASE)).toBe([
      '🔔 <b>2 tasks wait for you</b>',
      `👀 <b>To check · 1</b>\n• ${ref} Ship the importer`,
      `⛔ <b>Blocked · 1</b>\n• <a href="${BASE}/tasks/${stuck.id}">${stuck.ref}</a> Rotate the keys\n    <i>no access to the vault</i>`,
    ].join('\n\n'));
  });

  it('says the focus is done and how much was closed today', async () => {
    const { db: own, drop: dropOwn } = await createTestDb();
    try {
      const s = await seedAgentSession(own, { remote: 'git@github.com:me/now-done.git' });
      const ctx = { db: own, actor: s.actor };
      const r = await createTask(ctx, { projectId: s.project.id, title: 'Write the release notes', confirmNew: { reason: 't' } });
      if (r.outcome !== 'created') throw new Error('not created');
      const llm = new FakeLlm();
      llm.reviewResult = { summary: 'Easy day.', focus: [{ ref: r.task.ref, why: 'last step' }], priorities: [], findings: [] };
      await runReview({ db: own, llm }, 'daily');
      await startTask(ctx, { projectId: s.project.id, task: r.task.ref });
      await completeTask(ctx, { projectId: s.project.id, task: r.task.ref, result: 'Written.' });
      expect(await buildNow(own, BASE, new Date(), 'reminder')).toEqual({
        text: '✅ <b>Nothing waits for you right now.</b>\n\n🎯 Today\'s focus is done: 1 of 1\n\n✅ Closed today: 1',
        empty: true, // nothing to remind about
      });
      // yesterday's review says nothing about today
      await own.query(`UPDATE manager_reviews SET created_at = now() - interval '2 days'`);
      expect((await buildNow(own, BASE, new Date())).text).toBe('✅ <b>Nothing waits for you right now.</b>\n\n✅ Closed today: 1');
    } finally {
      await dropOwn();
    }
  });
});

describe('the review as a message', () => {
  let db: Db; let drop: () => Promise<void>;
  beforeAll(async () => ({ db, drop } = await createTestDb()));
  afterAll(async () => drop());

  it('shows the summary, the focus, what changed and the notes, with links to the tasks', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/review-msg.git' });
    const ctx = { db, actor: s.actor };
    const mk = async (title: string): Promise<Task> => {
      const r = await createTask(ctx, { projectId: s.project.id, title, confirmNew: { reason: 't' } });
      if (r.outcome !== 'created') throw new Error('not created');
      return r.task;
    };
    const [a, b, c, d, e] = [await mk('Fix the <login> form'), await mk('Old idea'), await mk('Third'), await mk('Fourth'), await mk('Fifth')];
    const at = (x: Task) => `<a href="${BASE}/tasks/${x.id}">${x.ref}</a>`;
    const llm = new FakeLlm();
    await updateSettings(db, { managerAuto: true });
    llm.reviewResult = {
      summary: 'Login is broken & blocks sign-ups.',
      focus: [{ ref: a!.ref, why: 'users cannot sign in' }],
      priorities: [{ ref: a!.ref, priority: 'urgent', reason: 'blocks sign-ups' }, { ref: b!.ref, priority: 'low', reason: 'nobody asked for it' }],
      findings: [{ kind: 'stale', refs: [b!.ref, 'NOPE-1'], note: 'no movement' }, { kind: 'risk', refs: [a!.ref], note: 'deadline <soon>' }],
    };
    const applied = await runReview({ db, llm }, 'owner');
    expect(await renderReview(db, applied, BASE)).toEqual([[
      '🧭 <b>Project review</b>\n<blockquote>Login is broken &amp; blocks sign-ups.</blockquote>',
      `🎯 <b>Focus for today</b>\n1. ${at(a!)} Fix the &lt;login&gt; form\n    <i>users cannot sign in</i>`,
      `⚖️ <b>Changed priorities · 2</b>\n⬆️ ${at(a!)} Fix the &lt;login&gt; form\n    Normal → <b>Urgent</b> — blocks sign-ups\n⬇️ ${at(b!)} Old idea\n    Normal → <b>Low</b> — nobody asked for it`,
      `📝 <b>Notes · 2</b>\n⏳ ${at(b!)} — no movement\n⚠️ ${at(a!)} — deadline &lt;soon&gt;`,
    ].join('\n\n')]);

    // when the manager may only suggest, the same changes are suggestions; a long list folds
    await updateSettings(db, { managerAuto: false });
    llm.reviewResult = {
      summary: 'Reorder.', focus: [], findings: [],
      priorities: [c!, d!, e!, b!].map((x) => ({ ref: x.ref, priority: 'high' as const, reason: 'sooner' })),
    };
    const suggested = await runReview({ db, llm }, 'owner');
    const [text] = await renderReview(db, suggested, null);
    expect(text).toContain('💡 <b>Suggested priorities · 4</b>\n<blockquote expandable>⬆️ <b>');
    expect(text).toContain(`⬆️ <b>${b!.ref}</b> Old idea\n    Low → <b>High</b> — sooner`);
    expect(text).not.toContain('Changed priorities');
    expect(text).not.toContain('<a ');
    await updateSettings(db, { managerAuto: true });
  });

  it('says so when there is nothing open, and splits a very long review into messages', async () => {
    const { db: own, drop: dropOwn } = await createTestDb();
    try {
      const empty = await runReview({ db: own, llm: new FakeLlm() }, 'owner');
      expect(await renderReview(own, empty, BASE)).toEqual(['🧭 <b>Project review</b>\nThere are no open tasks.']);
    } finally {
      await dropOwn();
    }
    const long = {
      id: 1, trigger: 'owner' as const, model: 'm', summary: 'S'.repeat(1900), createdAt: new Date(),
      focus: Array.from({ length: 5 }, (_, i) => ({ taskId: `id-${i}`, ref: `X-${i}`, title: 'T'.repeat(80), why: 'w'.repeat(200) })),
      changes: [],
      findings: Array.from({ length: 10 }, (_, i) => ({ kind: 'risk' as const, refs: [`X-${i}`], note: 'n'.repeat(300) })),
    };
    const messages = await renderReview(db, long, null);
    expect(messages.length).toBeGreaterThan(1);
    for (const m of messages) expect(visibleLength(m)).toBeLessThanOrEqual(4000);
    expect(messages[0]).toMatch(/^🧭 <b>Project review<\/b>\n<blockquote expandable>/);
    expect(messages.at(-1)).toContain('📝 <b>Notes · 10</b>');
  });
});
