import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../../../test/helpers/db';
import { seedAgentSession } from '../../../test/helpers/fixtures';
import {
  blockTask, completeTask, createTask, createTelegramLinkCode, getSettings, getTaskById, startTask, unlinkTelegram, updateSettings,
  type Db, type IntakeResult, type ManagerLlm, type ReviewResult,
} from '@conus/core';
import { createBot } from '../src/manager/bot';
import { TelegramApi, TelegramError, type TelegramClient, type TgKeyboard, type TgMessage, type TgUpdate } from '../src/telegram/api';

let db: Db; let drop: () => Promise<void>;
beforeAll(async () => ({ db, drop } = await createTestDb()));
afterAll(async () => drop());

const OWNER = 5150;
type Sent = { chatId: number; text: string; keyboard?: TgKeyboard; messageId: number };

/** Telegram stand-in: remembers what was sent and edited. */
class FakeTelegram implements TelegramClient {
  sent: Sent[] = [];
  edits: { chatId: number; messageId: number; text: string; keyboard?: TgKeyboard }[] = [];
  answers: { id: string; text?: string }[] = [];
  private next = 100;
  async getMe() { return { id: 1, username: 'conus_test_bot' }; }
  async deleteWebhook() {}
  async setMyCommands() {}
  async getUpdates() { return []; }
  async sendMessage(chatId: number, text: string, keyboard?: TgKeyboard): Promise<TgMessage> {
    const messageId = this.next++;
    this.sent.push({ chatId, text, keyboard, messageId });
    return { message_id: messageId, date: 0, chat: { id: chatId, type: 'private' }, text };
  }
  async editMessageText(chatId: number, messageId: number, text: string, keyboard?: TgKeyboard) { this.edits.push({ chatId, messageId, text, keyboard }); }
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

beforeEach(async () => {
  tg = new FakeTelegram();
  llm = new FakeLlm();
  clock = new Date('2026-11-09T12:00:00Z');
  await unlinkTelegram(db);
  await updateSettings(db, { timeZone: 'Europe/Moscow', digestTime: '09:00', quietFrom: '22:00', quietTo: '08:00', notifyReview: true, notifyBlocked: true });
});

describe('the bot', () => {
  it('links the owner’s chat with the one-time code and turns everyone else away', async () => {
    await bot().handleUpdate(msg('/start'));
    expect(tg.last().text).toContain('Settings → Telegram');
    await bot().handleUpdate(msg('/start not-the-code'));
    expect(tg.last().text).toContain('did not work');
    await link();
    expect(tg.last().text).toContain('Linked');
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
    expect(view.text).toContain('Two requests.');
    expect(view.text).toContain('Fix the export');
    const buttons = callbacks(view.keyboard);
    expect(buttons.filter((b) => b!.startsWith('pa:'))).toHaveLength(2);
    expect(buttons.some((b) => b!.startsWith('ba:'))).toBe(true);

    // accept the first: it becomes a task, the message redraws without its buttons
    const firstAccept = buttons.find((b) => b!.startsWith('pa:'))!;
    const firstId = firstAccept.slice(3);
    await bot().handleUpdate(press(firstAccept, placeholder.messageId));
    expect((await getTaskById(db, firstId))!.status).toBe('todo');
    expect(tg.lastEdit().text).toContain('accepted');
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
    expect(tg.lastEdit().text).toContain('model down');
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
    expect(notice.text).toContain(`${r.task.ref}</b> is waiting for your check`);
    expect(notice.text).toContain('PDF attached to invoices.');
    expect(callbacks(notice.keyboard)).toEqual([`rv:ok:${r.task.id}`, `rv:back:${r.task.id}`, `https://conus.example.com/tasks/${r.task.id}`]);
    await bot().sendNotices();
    expect(tg.sent.length).toBe(before + 1); // once
    await bot().handleUpdate(press(`rv:ok:${r.task.id}`, notice.messageId));
    expect((await getTaskById(db, r.task.id))!.status).toBe('done');
    expect(tg.lastEdit().text).toContain('Accepted');
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
    expect(tg.sent.slice(before).some((x) => x.text.includes('Night blocker') && x.text.includes('is blocked'))).toBe(false);
  });

  it('runs the review and sends the digest once a day at the digest time', async () => {
    await link();
    await db.query('UPDATE owner_settings SET last_digest_on = NULL, last_review_on = NULL');
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
    expect(digests[0]!.text).toContain('Calm day.');
    expect(digests[0]!.text).toContain('Open Conus');
  });

  it('answers /digest and /review on demand', async () => {
    await link();
    llm.reviewResult = { summary: 'All good.', focus: [], priorities: [], findings: [] };
    await bot().handleUpdate(msg('/review'));
    expect(tg.last().text).toContain('All good.');
    await bot().handleUpdate(msg('/digest'));
    expect(tg.last().text).toContain('Conus ·');
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
