import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../../../test/helpers/db';
import { seedAgentSession } from '../../../test/helpers/fixtures';
import { NullJudge, NullManagerLlm, createTask, setOwnerPassword, type Db, type IntakeResult, type ManagerLlm, type ReviewResult } from '@conus/core';
import { createApp } from '../src/app';
import type { ManagerStatus } from '../src/manager/run';
import type { TelegramClient, TgMessage } from '../src/telegram/api';

let db: Db; let drop: () => Promise<void>;
let cookie = ''; let csrf = '';

class FakeLlm implements ManagerLlm {
  readonly enabled = true;
  readonly model = 'claude-opus-5-5';
  intake: IntakeResult = { summary: 'Nothing much.', items: [] };
  reviewResult: ReviewResult = { summary: 'Fine.', focus: [], priorities: [], findings: [] };
  async extract() { return this.intake; }
  async review() { return this.reviewResult; }
}
const sent: { chatId: number; text: string }[] = [];
const fakeTelegram = {
  async sendMessage(chatId: number, text: string) { sent.push({ chatId, text }); return { message_id: 1, date: 0, chat: { id: chatId, type: 'private' } } as TgMessage; },
} as unknown as TelegramClient;
const llm = new FakeLlm();
const status: ManagerStatus = { llm, api: fakeTelegram, telegram: { configured: true, username: 'conus_test_bot', error: null } };

let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  ({ db, drop } = await createTestDb());
  app = createApp({ db, judge: new NullJudge(), manager: status });
  await setOwnerPassword(db, 'owner-password-1');
  const r = await app.request('/api/ui/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'owner-password-1' }) });
  const set = r.headers.getSetCookie();
  csrf = set.find((c) => c.startsWith('conus_csrf='))!.split(';')[0]!.split('=')[1]!;
  cookie = set.map((c) => c.split(';')[0]).join('; ');
});
afterAll(async () => drop());

type JsonResponse = Omit<Response, 'json'> & { json(): Promise<any> };
const req = (path: string, method = 'GET', json?: unknown, a = app): Promise<JsonResponse> => a.request(`/api/ui${path}`, {
  method, headers: { cookie, 'x-csrf-token': csrf, ...(json !== undefined ? { 'content-type': 'application/json' } : {}) },
  body: json !== undefined ? JSON.stringify(json) : undefined,
}) as Promise<JsonResponse>;

describe('manager API', () => {
  it('reads and changes the settings, and says what is configured without leaking anything secret', async () => {
    const r = await (await req('/settings')).json();
    expect(r).toEqual({
      settings: {
        timeZone: 'UTC', digestTime: '09:00', quietFrom: '22:00', quietTo: '08:00', notifyReview: true, notifyBlocked: true,
        managerAuto: true, remindEveryHours: 3, telegramUsername: null, telegramLinked: false,
      },
      telegram: { configured: true, botUsername: 'conus_test_bot', error: null },
      manager: { enabled: true, model: 'claude-opus-5-5' },
    });
    const p = await req('/settings', 'PATCH', { time_zone: 'Asia/Almaty', digest_time: '08:15', manager_auto: false });
    expect((await p.json()).settings).toMatchObject({ timeZone: 'Asia/Almaty', digestTime: '08:15', managerAuto: false });
    expect((await (await req('/settings', 'PATCH', { remind_every_hours: 6 })).json()).settings.remindEveryHours).toBe(6);
    expect((await (await req('/settings', 'PATCH', { remind_every_hours: 0 })).json()).settings.remindEveryHours).toBe(0); // off
    await req('/settings', 'PATCH', { remind_every_hours: 3 });
    for (const bad of [{ time_zone: 'Nowhere/City' }, { digest_time: '25:00' }, { quiet_from: '7:00' }, { remind_every_hours: 25 }, { remind_every_hours: 1.5 }, { remind_every_hours: -1 }]) {
      expect((await req('/settings', 'PATCH', bad)).status, JSON.stringify(bad)).toBe(400);
    }
    await req('/settings', 'PATCH', { manager_auto: true });
  });

  it('makes a one-time Telegram link, sends a test message once linked, and unlinks', async () => {
    const l = await (await req('/telegram/link', 'POST')).json();
    expect(l.url).toBe(`https://t.me/conus_test_bot?start=${l.code}`);
    expect(l.code).toMatch(/^[\w-]{16}$/);
    expect((await req('/telegram/test', 'POST')).status).toBe(503); // not linked yet
    await db.query('UPDATE owner_settings SET telegram_chat_id = 42, telegram_username = $1', ['owner']);
    expect((await req('/telegram/test', 'POST')).status).toBe(200);
    expect(sent.at(-1)!.chatId).toBe(42);
    expect(sent.at(-1)!.text).toContain('<b>Conus is here.</b>');
    expect((await (await req('/settings')).json()).settings).toMatchObject({ telegramLinked: true, telegramUsername: 'owner' });
    expect((await (await req('/telegram/unlink', 'POST')).json()).settings.telegramLinked).toBe(false);
  });

  it('turns pasted correspondence into proposals', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/ui-intake.git' });
    llm.intake = {
      summary: 'One request.',
      items: [{ project_key: s.project.key, title: 'Send the contract draft', description: 'by Friday', type: 'task', priority: 'high', due_on: null, source_quote: 'send me the contract', duplicate_of: null, requested_by: 'Client' }],
    };
    const r = await req('/intake', 'POST', { text: 'Client: send me the contract' });
    expect(r.status).toBe(200);
    const { batch } = await r.json();
    expect(batch).toMatchObject({ source: 'web', status: 'done', summary: 'One request.' });
    expect(batch.tasks[0]).toMatchObject({ title: 'Send the contract draft', status: 'proposed', priority: 'high', projectKey: s.project.key });
    expect((await req('/intake', 'POST', { text: '' })).status).toBe(400);
  });

  it('runs a review on demand and returns the latest one', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/ui-review.git' });
    const t = await createTask({ db, actor: s.actor }, { projectId: s.project.id, title: 'Reviewed task' });
    if (t.outcome !== 'created') throw new Error();
    llm.reviewResult = { summary: 'Fine.', focus: [{ ref: t.task.ref, why: 'next' }], priorities: [], findings: [] };
    const r = await (await req('/manager/review', 'POST')).json();
    expect(r.review).toMatchObject({ trigger: 'owner', model: 'claude-opus-5-5', focus: [{ ref: t.task.ref, why: 'next' }] });
    expect((await (await req('/manager/review')).json()).review.id).toBe(r.review.id);
  });

  it('moves a task between projects', async () => {
    const a = await seedAgentSession(db, { remote: 'git@github.com:me/ui-move-a.git' });
    const b = await seedAgentSession(db, { remote: 'git@github.com:me/ui-move-b.git' });
    const t = await createTask({ db, actor: a.actor }, { projectId: a.project.id, title: 'Move me' });
    if (t.outcome !== 'created') throw new Error();
    const r = await req(`/tasks/${t.task.id}/move`, 'POST', { project_id: b.project.id });
    expect((await r.json()).task.projectId).toBe(b.project.id);
  });

  it('says the manager is off when there is no model or bot', async () => {
    const off = createApp({ db, judge: new NullJudge(), manager: { llm: new NullManagerLlm(), api: null, telegram: { configured: false, username: null, error: null } } });
    const r = await req('/intake', 'POST', { text: 'anything' }, off);
    expect(r.status).toBe(503);
    expect((await r.json()).error).toMatchObject({ code: 'unavailable', details: { reason: 'not_configured' } });
    expect((await req('/manager/review', 'POST', undefined, off)).status).toBe(503);
    expect((await req('/telegram/link', 'POST', undefined, off)).status).toBe(503);
    expect((await (await req('/settings', 'GET', undefined, off)).json())).toMatchObject({ manager: { enabled: false, model: null }, telegram: { configured: false } });
  });
});
