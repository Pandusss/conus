import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../../../test/helpers/db';
import { seedAgentSession } from '../../../test/helpers/fixtures';
import {
  blockTask, completeTask, createTask, createTelegramLinkCode, getSettings, getTaskById, startTask, unlinkTelegram, updateSettings,
  type Db, type IntakeResult, type ManagerLlm, type ReviewResult,
} from '@conus/core';
import { createBot } from '../src/manager/bot';
import { TelegramApi, TelegramError, type TelegramClient, type TgKeyboard, type TgMessage, type TgUpdate } from '../src/telegram/api';

let db: Db;

const OWNER = 5150;
type Sent = { chatId: number; text: string; keyboard?: TgKeyboard; messageId: number };

/** Telegram stand-in: remembers what was sent and edited. */
class FakeTelegram implements TelegramClient {
  sent: Sent[] = [];
  edits: { chatId: number; messageId: number; text: string; keyboard?: TgKeyboard }[] = [];
  answers: { id: string; text?: string }[] = [];
  /** What the next sends and edits do: an error is thrown instead of delivering, null delivers. */
  failures: (Error | null)[] = [];
  private next = 100;
  private deliver() { const e = this.failures.shift(); if (e) throw e; }
  async getMe() { return { id: 1, username: 'conus_test_bot' }; }
  async deleteWebhook() {}
  async setMyCommands() {}
  async getUpdates() { return []; }
  async sendMessage(chatId: number, text: string, keyboard?: TgKeyboard): Promise<TgMessage> {
    this.deliver();
    const messageId = this.next++;
    this.sent.push({ chatId, text, keyboard, messageId });
    return { message_id: messageId, date: 0, chat: { id: chatId, type: 'private' }, text };
  }
  async editMessageText(chatId: number, messageId: number, text: string, keyboard?: TgKeyboard) {
    this.deliver();
    this.edits.push({ chatId, messageId, text, keyboard });
  }
  async answerCallbackQuery(id: string, text?: string) { this.answers.push({ id, text }); }
  async sendChatAction() {}
  last() { return this.sent.at(-1)!; }
  lastEdit() { return this.edits.at(-1)!; }
}

class FakeLlm implements ManagerLlm {
  readonly enabled = true;
  readonly model = 'fake';
  intake: IntakeResult = { summary: '', items: [] };
  reviewResult: ReviewResult = { summary: 'ok', focus: [], priorities: [], findings: [] };
  lastText = '';
  async extract(text: string) { this.lastText = text; return this.intake; }
  async review() { return this.reviewResult; }
}

let clock = new Date('2026-11-09T12:00:00Z');
let tg: FakeTelegram; let llm: FakeLlm;
const bot = () => createBot({ db, api: tg, llm, publicUrl: 'https://conus.example.com', now: () => clock, log: () => {} });
let u = 0;
const msg = (text: string, over: Partial<TgMessage> = {}): TgUpdate => ({
  update_id: ++u, message: { message_id: u, date: 0, chat: { id: OWNER, type: 'private' }, from: { id: OWNER, username: 'owner' }, text, ...over },
});
const press = (data: string, messageId: number, from = OWNER): TgUpdate => ({
  update_id: ++u, callback_query: { id: `cb${u}`, from: { id: from }, data, message: { message_id: messageId, date: 0, chat: { id: from, type: 'private' } } },
});
const callbacks = (kb: TgKeyboard | undefined) => (kb ?? []).flat().map((b) => ('callback_data' in b ? b.callback_data : b.url));

async function link() {
  const { code } = await createTelegramLinkCode(db, clock);
  await bot().handleUpdate(msg(`/start ${code}`));
}

/** A database of its own for a group of tests; every test starts unlinked, at 15:00 in Moscow, with the default schedule. */
function ownDb() {
  let drop: () => Promise<void>;
  beforeAll(async () => ({ db, drop } = await createTestDb()));
  afterAll(async () => drop());
  beforeEach(async () => {
    tg = new FakeTelegram();
    llm = new FakeLlm();
    clock = new Date('2026-11-09T12:00:00Z');
    await unlinkTelegram(db);
    await updateSettings(db, {
      timeZone: 'Europe/Moscow', digestTime: '09:00', quietFrom: '22:00', quietTo: '08:00', notifyReview: true, notifyBlocked: true, remindEveryHours: 3,
    });
    await db.query('UPDATE owner_settings SET last_reminder_at = NULL, reminders_muted = false, last_digest_on = NULL, last_review_on = NULL');
  });
}

/** A project with an agent, and tasks in it: plain, waiting for the owner's check, or blocked. */
async function project(remote: string) {
  const s = await seedAgentSession(db, { remote });
  const ctx = { db, actor: s.actor };
  const mk = async (title: string) => {
    const r = await createTask(ctx, { projectId: s.project.id, title, confirmNew: { reason: 'test' } });
    if (r.outcome !== 'created') throw new Error('not created');
    return r.task;
  };
  const toCheck = async (title: string, result = 'Done.') => {
    const x = await mk(title);
    await startTask(ctx, { projectId: s.project.id, task: x.ref });
    await completeTask(ctx, { projectId: s.project.id, task: x.ref, result, needsReview: true });
    return x;
  };
  const stuck = async (title: string, reason: string) => {
    const x = await mk(title);
    await blockTask(ctx, { projectId: s.project.id, task: x.ref, reason });
    return x;
  };
  return { ...s, ctx, mk, toCheck, stuck };
}
const hours = (n: number) => { clock = new Date(clock.getTime() + n * 3_600_000); };
const OPEN = 'https://conus.example.com';

describe('the bot', () => {
  ownDb();

  it('links the owner’s chat with the one-time code and turns everyone else away', async () => {
    await bot().handleUpdate(msg('/start'));
    expect(tg.last().text).toContain('Settings → Telegram');
    await bot().handleUpdate(msg('/start not-the-code'));
    expect(tg.last().text).toContain('did not work');
    await link();
    expect(tg.last().text).toContain('✅ <b>Linked.</b>');
    expect(tg.last().text).toContain('/now — what waits for me now'); // the help comes with it
    expect((await getSettings(db)).telegramChatId).toBe(OWNER);
    // a stranger who finds the bot gets nothing, not even with a code
    const stranger = msg('/start whatever', { chat: { id: 777, type: 'private' }, from: { id: 777 } });
    await bot().handleUpdate(stranger);
    await bot().handleUpdate(msg('hi', { chat: { id: 777, type: 'private' }, from: { id: 777 } }));
    expect(tg.last()).toMatchObject({ chatId: 777, text: 'This is a private Conus bot.' });
    // group chats are ignored
    const before = tg.sent.length;
    await bot().handleUpdate(msg('hi', { chat: { id: -100, type: 'group' } }));
    expect(tg.sent.length).toBe(before);
  });

  it('reads forwarded messages as one conversation once they stop coming, and offers the proposals with buttons', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/bot-intake.git' });
    await link();
    await bot().handleUpdate(msg('Can you fix the export?', { forward_origin: { type: 'user', date: 0, sender_user: { id: 9, first_name: 'Anna', last_name: 'K' } } }));
    await bot().handleUpdate(msg('And add dark mode, no rush', { forward_origin: { type: 'hidden_user', date: 0, sender_user_name: 'Investor' } }));
    await bot().flushInbox(); // too soon: still coming
    expect(llm.lastText).toBe('');
    clock = new Date(clock.getTime() + 6_000);
    llm.intake = {
      summary: 'Two requests.',
      items: [
        { project_key: s.project.key, title: 'Fix the export', description: '', type: 'bug', priority: 'high', due_on: null, source_quote: 'Can you fix the export?', duplicate_of: null, requested_by: 'Anna K' },
        { project_key: s.project.key, title: 'Add dark mode', description: '', type: 'task', priority: 'low', due_on: null, source_quote: 'add dark mode', duplicate_of: null, requested_by: null },
      ],
    };
    await bot().flushInbox();
    expect(llm.lastText).toBe('Anna K: Can you fix the export?\n\nInvestor: And add dark mode, no rush');
    const placeholder = tg.last();
    expect(placeholder.text).toContain('Reading');
    const view = tg.lastEdit();
    expect(view.messageId).toBe(placeholder.messageId);
    expect(view.text).toContain('🧠 <b>Sorted the correspondence</b>\n<blockquote>Two requests.</blockquote>');
    expect(view.text).toContain('<b>1.</b> Fix the export\n');
    expect(view.text).toMatch(/<b>2\.<\/b> Add dark mode\n {4}<a href="https:\/\/conus\.example\.com\/tasks\/[0-9a-f-]{36}">[A-Z]+-\d+<\/a> · bot-intake · ⬇️ low/);
    expect(view.text).toContain('✅ accept · ✖️ reject · 📁 another project');
    const buttons = callbacks(view.keyboard);
    expect(buttons.filter((b) => b!.startsWith('pa:'))).toHaveLength(2);
    expect(buttons.some((b) => b!.startsWith('ba:'))).toBe(true);

    // accept the first: it becomes a task, the message redraws without its buttons
    const firstAccept = buttons.find((b) => b!.startsWith('pa:'))!;
    const firstId = firstAccept.slice(3);
    await bot().handleUpdate(press(firstAccept, placeholder.messageId));
    expect((await getTaskById(db, firstId))!.status).toBe('todo');
    expect(tg.lastEdit().text).toContain('⬆️ high · ✅ accepted');
    expect(callbacks(tg.lastEdit().keyboard).filter((b) => b!.startsWith('pa:'))).toHaveLength(1);

    // the project picker, then a move
    const other = await seedAgentSession(db, { remote: 'git@github.com:me/bot-other.git' });
    const secondId = callbacks(tg.lastEdit().keyboard).find((b) => b!.startsWith('pm:'))!.slice(3);
    await bot().handleUpdate(press(`pm:${secondId}`, placeholder.messageId));
    expect(callbacks(tg.lastEdit().keyboard)).toContain(`pt:${secondId}:${other.project.key}`);
    await bot().handleUpdate(press(`pt:${secondId}:${other.project.key}`, placeholder.messageId));
    expect((await getTaskById(db, secondId))!.projectId).toBe(other.project.id);
    // reject the rest
    const batchButton = callbacks(tg.lastEdit().keyboard).find((b) => b!.startsWith('pr:'))!;
    await bot().handleUpdate(press(batchButton, placeholder.messageId));
    expect((await getTaskById(db, secondId))!.status).toBe('dropped');
    expect(tg.lastEdit().text).toContain('<s>Add dark mode</s>');
    expect(tg.lastEdit().text).toContain('✖️ rejected');
    expect(tg.lastEdit().text).not.toContain('another project'); // nothing left to decide: no legend, no buttons
    expect(callbacks(tg.lastEdit().keyboard)).toEqual([]);
  });

  it('refuses buttons pressed outside the owner’s chat', async () => {
    await link();
    await bot().handleUpdate(press('ba:1', 1, 999));
    expect(tg.answers.at(-1)!.text).toBe('Not allowed.');
  });

  it('tells the owner when the model failed, and does not read the same messages again', async () => {
    await link();
    await bot().handleUpdate(msg('please remember the meeting'));
    clock = new Date(clock.getTime() + 6_000);
    llm.extract = async () => { throw new Error('model down'); };
    await bot().flushInbox();
    expect(tg.lastEdit().text).toContain('⚠️ <b>Could not sort it out</b>\n<blockquote>model down</blockquote>');
    const calls = tg.edits.length;
    await bot().flushInbox();
    expect(tg.edits.length).toBe(calls);
  });

  it('sends a notice with buttons when a task goes to review or gets blocked, and acts on them', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/bot-notice.git' });
    const ctx = { db, actor: s.actor };
    await link();
    await bot().sendNotices(); // catch up with whatever happened before
    const r = await createTask(ctx, { projectId: s.project.id, title: 'Ship the invoice PDF' });
    if (r.outcome !== 'created') throw new Error();
    await startTask(ctx, { projectId: s.project.id, task: r.task.ref });
    await completeTask(ctx, { projectId: s.project.id, task: r.task.ref, result: 'PDF attached to invoices.', needsReview: true });
    const before = tg.sent.length;
    await bot().sendNotices();
    const notice = tg.sent[before]!;
    expect(notice.text).toBe([
      '👀 <b>To check: Ship the invoice PDF</b>',
      `<a href="${OPEN}/tasks/${r.task.id}">${r.task.ref}</a> · bot-notice`,
      '<blockquote>PDF attached to invoices.</blockquote>',
    ].join('\n'));
    expect(callbacks(notice.keyboard)).toEqual([`rv:ok:${r.task.id}`, `rv:back:${r.task.id}`, `https://conus.example.com/tasks/${r.task.id}`]);
    await bot().sendNotices();
    expect(tg.sent.length).toBe(before + 1); // once
    await bot().handleUpdate(press(`rv:ok:${r.task.id}`, notice.messageId));
    expect((await getTaskById(db, r.task.id))!.status).toBe('done');
    expect(tg.lastEdit().text).toContain('To check: Ship the invoice PDF'); // the notice stays, with the outcome under it
    expect(tg.lastEdit().text).toContain('✅ <b>Accepted</b>');
    expect(tg.lastEdit().keyboard).toBeUndefined();
    await bot().handleUpdate(press(`rv:back:${r.task.id}`, notice.messageId)); // a second press changes nothing
    expect((await getTaskById(db, r.task.id))!.status).toBe('done');
    expect(tg.answers.at(-1)!.text).toBe('Already handled');
  });

  it('sends many notices at once as one message', async () => {
    const s = await project('git@github.com:me/bot-burst.git');
    await link();
    await bot().sendNotices();
    for (let i = 1; i <= 5; i++) await s.toCheck(`Burst check ${i}`);
    const last = await s.stuck('Burst blocker', 'waiting for access');
    const before = tg.sent.length;
    await bot().sendNotices();
    expect(tg.sent.length).toBe(before + 1);
    const burst = tg.last();
    expect(burst.text).toContain('🔔 <b>6 tasks wait for you</b>');
    expect(burst.text).toContain('👀 <b>To check · 5</b>');
    expect(burst.text).toContain(`⛔ <b>Blocked · 1</b>\n• <a href="${OPEN}/tasks/${last.id}">${last.ref}</a> Burst blocker\n    <i>waiting for access</i>`);
    expect(callbacks(burst.keyboard)).toEqual([OPEN]);
  });

  it('does not repeat the notices that went out when a later one fails', async () => {
    const s = await project('git@github.com:me/bot-partial.git');
    await link();
    await bot().sendNotices();
    await s.toCheck('First of two');
    await s.toCheck('Second of two');
    const before = tg.sent.length;
    tg.failures = [null, new Error('network down')];
    await expect(bot().sendNotices()).rejects.toThrow('network down');
    await bot().sendNotices();
    const texts = tg.sent.slice(before).map((x) => x.text);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('First of two');
    expect(texts[1]).toContain('Second of two');
  });

  it('sends a message as plain text when Telegram refuses its markup, and lets other errors through', async () => {
    await link();
    tg.failures = [new TelegramError(400, "sendMessage: Bad Request: can't parse entities")];
    await bot().handleUpdate(msg('/help'));
    expect(tg.last().text).toContain('Conus manager');
    expect(tg.last().text).not.toMatch(/<\/?[a-z]/);
    tg.failures = [new TelegramError(403, 'sendMessage: Forbidden: bot was blocked by the user')];
    await expect(bot().handleUpdate(msg('/help'))).rejects.toThrow('Forbidden');
  });

  it('explains itself with the owner’s own schedule', async () => {
    await link();
    await bot().handleUpdate(msg('/help'));
    const help = tg.last().text;
    expect(help).toContain('🤖 <b>Conus manager</b>');
    expect(help).toContain('☀️ At 09:00 — a review of all projects and the digest for the day');
    expect(help).toContain('⏰ Every 3 hours — a reminder, while something waits for you');
    expect(help).toContain('👀 Right away — tasks to check and blockers');
    expect(help).toContain('🌙 From 22:00 to 08:00 I keep quiet');
    expect(help).toContain(`<a href="${OPEN}/settings">Conus → Settings</a>. Time zone: Europe/Moscow.`);
    await updateSettings(db, { remindEveryHours: 0, notifyReview: false, quietFrom: '00:00', quietTo: '00:00' });
    await bot().handleUpdate(msg('/unknown'));
    const other = tg.last().text;
    expect(other).toContain('⏰ Reminders between digests are off');
    expect(other).toContain('👀 Right away — blockers');
    expect(other).not.toContain('🌙');
  });

  it('keeps quiet at night: the feed moves on, the morning digest covers it', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/bot-quiet.git' });
    const ctx = { db, actor: s.actor };
    await link();
    await bot().sendNotices();
    clock = new Date('2026-11-09T20:30:00Z'); // 23:30 in Moscow
    const r = await createTask(ctx, { projectId: s.project.id, title: 'Night blocker' });
    if (r.outcome !== 'created') throw new Error();
    await blockTask(ctx, { projectId: s.project.id, task: r.task.ref, reason: 'no access' });
    const before = tg.sent.length;
    await bot().sendNotices();
    clock = new Date('2026-11-10T06:00:00Z'); // 09:00, but the notice is not re-sent
    await bot().sendNotices();
    expect(tg.sent.slice(before)).toEqual([]);
  });

  it('runs the review and sends the digest once a day at the digest time', async () => {
    await link();
    await db.query('UPDATE owner_settings SET reminders_muted = true');
    let reviews = 0;
    llm.review = async () => { reviews++; return { summary: 'Calm day.', focus: [], priorities: [], findings: [] }; };
    clock = new Date('2026-11-10T05:30:00Z'); // 08:30 Moscow: too early
    await bot().dailyRun();
    expect(reviews).toBe(0);
    clock = new Date('2026-11-10T06:05:00Z'); // 09:05
    const before = tg.sent.length;
    await bot().dailyRun();
    await bot().dailyRun();
    expect(reviews).toBe(1);
    const digests = tg.sent.slice(before);
    expect(digests).toHaveLength(1);
    expect(digests[0]!.text).toContain('☀️ <b>Digest · Tuesday, November 10</b>\n<blockquote>Calm day.</blockquote>');
    expect(digests[0]!.text).toContain('📊 <b>Projects</b>');
    expect(callbacks(digests[0]!.keyboard)).toEqual([OPEN]);
    // the digest starts a new round of reminders and ends «quiet until the next digest»
    expect(await getSettings(db)).toMatchObject({ remindersMuted: false, lastReminderAt: clock, lastDigestOn: '2026-11-10' });
  });

  it('answers /digest, /review and /now on demand', async () => {
    await link();
    llm.reviewResult = { summary: 'All good.', focus: [], priorities: [], findings: [] };
    await bot().handleUpdate(msg('/review'));
    expect(tg.last().text).toContain('🧭 <b>Project review</b>\n<blockquote>All good.</blockquote>');
    await bot().handleUpdate(msg('/digest'));
    expect(tg.last().text).toContain('☀️ <b>Digest · Monday, November 9</b>');
    expect(callbacks(tg.last().keyboard)).toEqual([OPEN]);
    await bot().handleUpdate(msg('/now'));
    expect(tg.last().text).toMatch(/^📌 <b>\d+ tasks? waits? for you<\/b>/);
    expect(callbacks(tg.last().keyboard)).toEqual([OPEN]);
  });
});

describe('reminders', () => {
  ownDb();
  /** No quiet hours and no digest ahead: only the interval decides. */
  const anyTime = () => updateSettings(db, { quietFrom: '00:00', quietTo: '00:00', digestTime: '00:00' });

  it('keeps silent while nothing waits, then reminds every few hours once something does', async () => {
    const s = await project('git@github.com:me/remind.git');
    await link();
    await anyTime();
    await db.query('UPDATE owner_settings SET last_digest_on = $1', ['2026-11-09']);
    await bot().handleUpdate(msg('/now'));
    expect(tg.last().text).toBe('✅ <b>Nothing waits for you right now.</b>');
    const b = bot();
    const start = tg.sent.length;
    await b.remind(); // the first look only starts the clock
    expect((await getSettings(db)).lastReminderAt).toEqual(clock);
    hours(3.1);
    await b.remind(); // nothing waits: no message
    expect(tg.sent.length).toBe(start);

    const check = await s.toCheck('Approve the landing copy');
    hours(2.9);
    await b.remind(); // three hours have not passed since the last look
    expect(tg.sent.length).toBe(start);
    hours(0.2);
    await b.remind();
    expect(tg.sent.length).toBe(start + 1);
    expect(tg.last().text).toContain('⏰ <b>1 task waits for you</b>\n\n👀 <b>To check · 1</b>\n');
    expect(tg.last().text).toContain(`<a href="${OPEN}/tasks/${check.id}">${check.ref}</a> Approve the landing copy`);
    expect(callbacks(tg.last().keyboard)).toEqual([OPEN, 'rm:mute']);
    await b.remind();
    expect(tg.sent.length).toBe(start + 1); // once per interval

    // right after an immediate notice a reminder would say the same thing twice: it waits half an hour
    hours(2.8);
    await b.sendNotices(); // catches up with the check above…
    const stuck = await s.stuck('Wait for the API keys', 'no keys yet');
    await b.sendNotices(); // …and tells about the blocker
    expect(tg.last().text).toContain('⛔ <b>Blocked: Wait for the API keys</b>');
    const told = tg.sent.length;
    hours(0.3);
    await b.remind();
    expect(tg.sent.length).toBe(told);
    hours(0.3);
    await b.remind();
    expect(tg.sent.length).toBe(told + 1);
    expect(tg.last().text).toContain('⏰ <b>2 tasks wait for you</b>');
    expect(tg.last().text).toContain(`⛔ <b>Blocked · 1</b>\n• <a href="${OPEN}/tasks/${stuck.id}">${stuck.ref}</a> Wait for the API keys\n    <i>no keys yet</i>`);
  });

  it('goes quiet until the next digest on a button, and comes back on another', async () => {
    const s = await project('git@github.com:me/remind-mute.git');
    await s.toCheck('Look at the new pricing page');
    await link();
    await anyTime();
    await db.query('UPDATE owner_settings SET last_reminder_at = $1, last_digest_on = $2', [new Date(clock.getTime() - 4 * 3_600_000), '2026-11-09']);
    await bot().remind();
    const reminder = tg.last();
    expect(callbacks(reminder.keyboard)).toContain('rm:mute');

    await bot().handleUpdate(press('rm:mute', reminder.messageId));
    expect(tg.answers.at(-1)!.text).toBe('Quiet until the next digest');
    expect(tg.lastEdit().text).toContain('Look at the new pricing page'); // the list stays
    expect(tg.lastEdit().text).toContain('🔕 <i>No reminders until the next digest.</i>');
    expect(callbacks(tg.lastEdit().keyboard)).toEqual([OPEN, 'rm:on']);
    const before = tg.sent.length;
    hours(3.1);
    await bot().remind();
    expect(tg.sent.length).toBe(before);
    await bot().handleUpdate(msg('/help'));
    expect(tg.last().text).toContain('(quiet until the next digest)');

    await bot().handleUpdate(press('rm:on', reminder.messageId));
    expect(tg.answers.at(-1)!.text).toBe('Reminders are back on');
    expect(tg.lastEdit().text).not.toContain('🔕');
    expect(callbacks(tg.lastEdit().keyboard)).toEqual([OPEN, 'rm:mute']);
    await bot().remind();
    expect(tg.last().text).toMatch(/^⏰ <b>\d+ tasks? waits? for you<\/b>/);

    // a stranger cannot touch the switch
    await bot().handleUpdate(press('rm:mute', reminder.messageId, 999));
    expect((await getSettings(db)).remindersMuted).toBe(false);
  });

  it('does not remind in quiet hours, just before the digest or right after it', async () => {
    const s = await project('git@github.com:me/remind-quiet.git');
    await s.toCheck('Night check');
    await link();
    clock = new Date('2026-11-09T20:30:00Z'); // 23:30 in Moscow
    await db.query('UPDATE owner_settings SET last_reminder_at = $1, last_digest_on = $2', [new Date(clock.getTime() - 4 * 3_600_000), '2026-11-09']);
    const before = tg.sent.length;
    await bot().remind();
    expect(tg.sent.length).toBe(before);
    clock = new Date('2026-11-10T05:10:00Z'); // 08:10: the night is over, but the digest comes at 09:00
    await bot().remind();
    expect(tg.sent.length).toBe(before);
    clock = new Date('2026-11-10T06:01:00Z'); // 09:01
    await bot().dailyRun();
    expect(tg.sent.length).toBe(before + 1);
    expect(tg.last().text).toContain('☀️ <b>Digest');
    clock = new Date('2026-11-10T06:40:00Z'); // 09:40: the digest has just said it all
    await bot().remind();
    expect(tg.sent.length).toBe(before + 1);
    clock = new Date('2026-11-10T09:02:00Z'); // 12:02
    await bot().remind();
    expect(tg.sent.length).toBe(before + 2);
    expect(tg.last().text).toMatch(/^⏰ <b>/);
  });

  it('does not remind when reminders are off or no chat is linked', async () => {
    const s = await project('git@github.com:me/remind-off.git');
    await s.toCheck('Nobody is told');
    await anyTime();
    await db.query('UPDATE owner_settings SET last_reminder_at = $1, last_digest_on = $2', [new Date(clock.getTime() - 30 * 3_600_000), '2026-11-09']);
    await bot().remind(); // not linked
    expect(tg.sent).toEqual([]);
    await link();
    await updateSettings(db, { remindEveryHours: 0 });
    const before = tg.sent.length;
    await bot().remind();
    expect(tg.sent.length).toBe(before);
    await updateSettings(db, { remindEveryHours: 1 });
    await bot().remind();
    expect(tg.sent.length).toBe(before + 1);
    // without a bot there is nothing to send with
    await db.query('UPDATE owner_settings SET last_reminder_at = $1', [new Date(clock.getTime() - 30 * 3_600_000)]);
    await createBot({ db, api: null, llm, publicUrl: OPEN, now: () => clock, log: () => {} }).remind();
    expect(tg.sent.length).toBe(before + 1);
  });
});

describe('the Telegram client', () => {
  it('posts JSON to the method and never puts the token in an error', async () => {
    const calls: { url: string; body: any }[] = [];
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      if (url.endsWith('/sendMessage')) return ok({ message_id: 7, date: 0, chat: { id: 1, type: 'private' } });
      if (url.endsWith('/editMessageText')) return new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: message is not modified' }));
      if (url.endsWith('/getMe')) return new Response(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }));
      throw new Error(`connect ECONNREFUSED ${url}`);
    }) as unknown as typeof fetch;
    const api = new TelegramApi('123:SECRET-TOKEN', fetchFn);
    const m = await api.sendMessage(1, '<b>hi</b>', [[{ text: 'x', callback_data: 'y' }]]);
    expect(m.message_id).toBe(7);
    expect(calls[0]).toMatchObject({
      url: 'https://api.telegram.org/bot123:SECRET-TOKEN/sendMessage',
      body: { chat_id: 1, text: '<b>hi</b>', parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: 'x', callback_data: 'y' }]] } },
    });
    await expect(api.editMessageText(1, 7, 'same')).resolves.toBeUndefined(); // "not modified" is fine
    const unauthorized = await api.getMe().catch((e) => e);
    expect(unauthorized).toBeInstanceOf(TelegramError);
    expect(unauthorized.code).toBe(401);
    const network = await api.deleteWebhook().catch((e) => e);
    expect(network.message).toBe('Telegram: deleteWebhook: network error');
    for (const e of [unauthorized, network]) expect(String(e.message)).not.toContain('SECRET');
  });
});
