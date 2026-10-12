import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../../../test/helpers/db';
import { NullJudge, verifyOwnerPassword, type Db } from './test-imports';
import { createApp } from '../src/app';
import { newSetupCode, setupCodeMatches } from '../src/setup-code';

let db: Db; let drop: () => Promise<void>;
beforeAll(async () => ({ db, drop } = await createTestDb()));
afterAll(async () => drop());

type JsonResponse = Omit<Response, 'json'> & { json(): Promise<any> };
const post = async (app: ReturnType<typeof createApp>, path: string, json: unknown, ip: string): Promise<JsonResponse> =>
  app.request(`/api/ui${path}`, { method: 'POST', body: JSON.stringify(json), headers: { 'content-type': 'application/json', 'x-forwarded-for': ip } });

describe('first-run setup in the browser', () => {
  it('needs the setup code, sets the owner password once, logs the owner in, then refuses', async () => {
    const app = createApp({ db, judge: new NullJudge(), setupCode: 'ABCD-EFGH' });
    expect(await (await app.request('/api/ui/setup')).json()).toEqual({ needed: true });

    const wrong = await post(app, '/setup', { code: 'ABCD-EFGX', password: 'owner-password-1' }, '10.0.0.1');
    expect(wrong.status).toBe(403);
    expect((await wrong.json()).error.code).toBe('wrong_setup_code');

    const short = await post(app, '/setup', { code: 'abcd efgh', password: 'short' }, '10.0.0.1');
    expect(short.status).toBe(400);

    const ok = await post(app, '/setup', { code: 'abcd efgh', password: 'owner-password-1' }, '10.0.0.1');
    expect(ok.status).toBe(200);
    expect(ok.headers.getSetCookie().some((c) => c.startsWith('conus_session='))).toBe(true);
    expect(await verifyOwnerPassword(db, 'owner-password-1')).toBe(true);
    expect(await (await app.request('/api/ui/setup')).json()).toEqual({ needed: false });

    const again = await post(app, '/setup', { code: 'ABCD-EFGH', password: 'attacker-password' }, '10.0.0.2');
    expect(again.status).toBe(409);
    expect((await again.json()).error.code).toBe('already_set_up');
    expect(await verifyOwnerPassword(db, 'owner-password-1')).toBe(true);
  });

  it('is closed without a setup code (an owner existed when the server started)', async () => {
    const app = createApp({ db, judge: new NullJudge(), setupCode: null });
    const r = await post(app, '/setup', { code: '', password: 'owner-password-2' }, '10.0.0.3');
    expect(r.status).toBe(409);
  });

  it('codes are 8 unambiguous characters; matching ignores case, spaces and dashes', () => {
    for (let i = 0; i < 50; i++) expect(newSetupCode()).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    expect(setupCodeMatches(' abcd-efgh ', 'ABCD-EFGH')).toBe(true);
    expect(setupCodeMatches('ABCDEFG', 'ABCD-EFGH')).toBe(false);
    expect(setupCodeMatches('', '')).toBe(false);
  });
});
