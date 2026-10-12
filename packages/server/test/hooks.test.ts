import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../../../test/helpers/db';
import {
  createAgent, createTask, getSessionByAgentSessionId, getSessionById, NullJudge, OK_VERDICT, PROTOCOL_CORE_REF, type Db, type Judge,
} from './test-imports';
import { createApp } from '../src/app';
import { RateLimiter } from '../src/rate-limit';

let db: Db; let drop: () => Promise<void>;
let app: ReturnType<typeof createApp>;
let token: string;
beforeAll(async () => {
  ({ db, drop } = await createTestDb());
  app = createApp({ db, judge: new NullJudge() });
  ({ token } = await createAgent(db, { name: 'claude-code@test', kind: 'claude_code' }));
});
afterAll(async () => drop());

const post = (path: string, body: unknown, t = token) =>
  app.request(`/api/hooks${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const repo = { remote: 'git@github.com:me/hooks.git', root_name: 'hooks', root_path_hash: 'abc', branch: 'main' };

describe('hooks API', () => {
  it('rejects missing or bad tokens', async () => {
    expect((await app.request('/api/hooks/whoami')).status).toBe(401);
    expect((await post('/session/start', {}, 'tm_bad')).status).toBe(401);
  });

  it('whoami', async () => {
    const r = await app.request('/api/hooks/whoami', { headers: { Authorization: `Bearer ${token}` } });
    expect(await r.json()).toEqual({ agent: { name: 'claude-code@test', kind: 'claude_code' } });
  });

  it('validates bodies', async () => {
    const r = await post('/session/start', { agent_session_id: 'x' });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('validation');
  });

  it('full turn: start → prompt → activity → stop nudges on unlinked work → end', async () => {
    const s = await post('/session/start', { agent_session_id: 'cc-1', source: 'startup', cwd: '/w/hooks', repo, model: 'claude-x' });
    expect(s.status).toBe(200);
    const sj = (await s.json()) as { enabled: boolean; session_ref: string; project_key: string; context: string };
    expect(sj.enabled).toBe(true);
    expect(sj.session_ref).toMatch(/^S-/);
    expect(sj.project_key).toBe('HOO');
    expect(sj.context).toContain(PROTOCOL_CORE_REF);

    const p = await post('/turn/prompt', { agent_session_id: 'cc-1', prompt_excerpt: 'добавь импорт CSV' });
    expect(((await p.json()) as { status_line: string }).status_line).toBe(`[conus ${sj.session_ref} · HOO · in progress: —]`);

    const facts = ['a.ts', 'b.ts', 'c.ts'].map((path) => ({ kind: 'file_edit', data: { path } }));
    expect((await post('/activity', { agent_session_id: 'cc-1', facts, idempotency_key: 'k1' })).status).toBe(204);
    expect((await post('/activity', { agent_session_id: 'cc-1', facts, idempotency_key: 'k1' })).status).toBe(204);
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM session_activity WHERE kind = 'file_edit'`);
    expect(rows[0].n).toBe(3);

    const st = await post('/turn/stop', { agent_session_id: 'cc-1', stop_hook_active: false, answer_excerpt: 'Сделал.' });
    const stj = (await st.json()) as { action: string; reason?: string };
    expect(stj.action).toBe('nudge');
    expect(stj.reason).toContain('a.ts');
    expect(await (await post('/turn/stop', { agent_session_id: 'cc-1', stop_hook_active: true })).json()).toEqual({ action: 'ok' });

    expect((await post('/session/end', { agent_session_id: 'cc-1', reason: 'prompt_input_exit' })).status).toBe(204);
    const { rows: srows } = await db.query(`SELECT state, end_reason FROM sessions WHERE agent_session_id = 'cc-1'`);
    expect(srows[0]).toEqual({ state: 'ended', end_reason: 'prompt_input_exit' });
  });

  it('unknown sessions: prompt/stop/end stay harmless, activity gets a retryable 409 unknown_session', async () => {
    expect(await (await post('/turn/prompt', { agent_session_id: 'nope' })).json()).toEqual({ status_line: '' });
    const act = await post('/activity', { agent_session_id: 'nope', facts: [{ kind: 'file_edit', data: { path: 'a.ts' } }] });
    expect(act.status).toBe(409);
    expect(((await act.json()) as { error: { code: string } }).error.code).toBe('unknown_session');
    expect(await (await post('/turn/stop', { agent_session_id: 'nope' })).json()).toEqual({ action: 'ok' });
    expect((await post('/session/end', { agent_session_id: 'nope' })).status).toBe(204);
    // nothing was recorded for it, and the same activity is accepted once the session exists
    expect((await post('/session/start', { agent_session_id: 'nope', cwd: '.', repo })).status).toBe(200);
    expect((await post('/activity', { agent_session_id: 'nope', facts: [{ kind: 'file_edit', data: { path: 'a.ts' } }] })).status).toBe(204);
  });

  it('a replayed session/start (queued by conus) is one session: same row, same ref', async () => {
    const body = { agent_session_id: 'cc-replay', source: 'startup', cwd: '.', repo };
    const a = (await (await post('/session/start', body)).json()) as { session_ref: string };
    const b = (await (await post('/session/start', body)).json()) as { session_ref: string };
    expect(b.session_ref).toBe(a.session_ref);
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM sessions WHERE agent_session_id = 'cc-replay'`);
    expect(rows[0].n).toBe(1);
  });

  it('stop stores the reported model on the session; commits linked afterwards carry it; amends replace the link', async () => {
    const { agent, token: t } = await createAgent(db, { name: 'cc-model@test', kind: 'claude_code' });
    const mrepo = { ...repo, remote: 'git@github.com:me/hooks-model.git', root_path_hash: 'model' };
    expect((await post('/session/start', { agent_session_id: 'cc-m', cwd: '/w/hooks', repo: mrepo }, t)).status).toBe(200);
    const session = (await getSessionByAgentSessionId(db, agent.id, 'cc-m'))!;
    expect(session.model).toBeNull(); // a real Claude SessionStart carries no model
    const created = await createTask({ db, actor: { kind: 'agent', agentId: agent.id, sessionId: session.id, model: null } }, { projectId: session.projectId!, title: 'Модель в истории', startNow: true });
    if (created.outcome !== 'created') throw new Error();
    await post('/turn/prompt', { agent_session_id: 'cc-m' }, t);
    const old = 'a'.repeat(40);
    const neu = 'b'.repeat(40);
    const facts = [{ kind: 'git_commit', data: { sha: old, subject: '@ x' } }, { kind: 'git_commit', data: { sha: neu, subject: 'x', amends: old } }];
    expect((await post('/activity', { agent_session_id: 'cc-m', facts }, t)).status).toBe(204);
    expect(await (await post('/turn/stop', { agent_session_id: 'cc-m', model: 'claude-opus-5' }, t)).json()).toEqual({ action: 'ok' });
    expect((await getSessionById(db, session.id))?.model).toBe('claude-opus-5');
    const ev = await db.query(`SELECT model FROM task_events WHERE task_id = $1 AND type = 'commit_linked' ORDER BY id`, [created.task.id]);
    expect(ev.rows.map((r) => r.model)).toEqual(['claude-opus-5', 'claude-opus-5']);
    const links = await db.query(`SELECT ref FROM links WHERE task_id = $1`, [created.task.id]);
    expect(links.rows.map((r) => r.ref)).toEqual([neu]);
    // no model in the body leaves the stored one alone
    await post('/turn/stop', { agent_session_id: 'cc-m' }, t);
    expect((await getSessionById(db, session.id))?.model).toBe('claude-opus-5');
    expect((await post('/turn/stop', { agent_session_id: 'cc-m', model: 'm'.repeat(101) }, t)).status).toBe(400);
    const bad = [{ kind: 'git_commit', data: { sha: neu, subject: 'x', amends: 'zz' } }];
    expect((await post('/activity', { agent_session_id: 'cc-m', facts: bad }, t)).status).toBe(400);
  });

  it('turn/stop facts: the commit Stop reports is linked before the check; the late PostToolUse duplicate adds nothing', async () => {
    const { agent, token: t } = await createAgent(db, { name: 'cc-stopfacts@test', kind: 'claude_code' });
    const srepo = { ...repo, remote: 'git@github.com:me/hooks-stopfacts.git', root_path_hash: 'sf' };
    expect((await post('/session/start', { agent_session_id: 'cc-sf', cwd: '.', repo: srepo }, t)).status).toBe(200);
    const session = (await getSessionByAgentSessionId(db, agent.id, 'cc-sf'))!;
    const created = await createTask({ db, actor: { kind: 'agent', agentId: agent.id, sessionId: session.id, model: null } }, { projectId: session.projectId!, title: 'Стоп-факты', startNow: true });
    if (created.outcome !== 'created') throw new Error();
    const sha = 'c0ffee'.padEnd(40, '0');
    await post('/turn/prompt', { agent_session_id: 'cc-sf' }, t);
    const fact = { kind: 'git_commit', data: { sha, subject: 'feat: stop facts', branch: 'main' } };
    expect(await (await post('/turn/stop', { agent_session_id: 'cc-sf', facts: [fact] }, t)).json()).toEqual({ action: 'ok' });
    const links = async () => (await db.query(`SELECT ref, meta FROM links WHERE task_id = $1`, [created.task.id])).rows;
    const linkedEvents = async () => (await db.query(`SELECT count(*)::int AS n FROM task_events WHERE task_id = $1 AND type = 'commit_linked'`, [created.task.id])).rows[0].n;
    expect(await links()).toEqual([{ ref: sha, meta: { subject: 'feat: stop facts', branch: 'main' } }]);
    expect(await linkedEvents()).toBe(1);
    // the async PostToolUse fact arrives late (same turn and next turn), and a queued replay of it too
    expect((await post('/activity', { agent_session_id: 'cc-sf', facts: [{ kind: 'git_commit', data: { sha, subject: 'feat: stop facts' } }] }, t)).status).toBe(204);
    await post('/turn/prompt', { agent_session_id: 'cc-sf' }, t);
    expect((await post('/activity', { agent_session_id: 'cc-sf', facts: [{ kind: 'git_commit', data: { sha: sha.slice(0, 7), subject: 'feat: stop facts' } }] }, t)).status).toBe(204);
    expect(await (await post('/turn/stop', { agent_session_id: 'cc-sf' }, t)).json()).toEqual({ action: 'ok' });
    expect(await links()).toHaveLength(1);
    expect(await linkedEvents()).toBe(1);
    const act = await db.query(`SELECT count(*)::int AS n FROM session_activity WHERE session_id = $1 AND kind = 'git_commit'`, [session.id]);
    expect(act.rows[0].n).toBe(1);
  });

  it('turn/stop facts without a task: one D1 nudge; the late duplicate never nudges again, even in a new task-op epoch', async () => {
    const { agent, token: t } = await createAgent(db, { name: 'cc-stopd1@test', kind: 'claude_code' });
    const srepo = { ...repo, remote: 'git@github.com:me/hooks-stopd1.git', root_path_hash: 'sd' };
    await post('/session/start', { agent_session_id: 'cc-d1', cwd: '.', repo: srepo }, t);
    const session = (await getSessionByAgentSessionId(db, agent.id, 'cc-d1'))!;
    const sha = 'd1d1d1'.padEnd(40, '0');
    await post('/turn/prompt', { agent_session_id: 'cc-d1' }, t);
    const first = (await (await post('/turn/stop', { agent_session_id: 'cc-d1', facts: [{ kind: 'git_commit', data: { sha, subject: 'x' } }] }, t)).json()) as { action: string };
    expect(first.action).toBe('nudge');
    // the agent looked at its tasks (a task op opens a new D1 epoch), then the duplicate fact arrives in the next turn
    await post('/activity', { agent_session_id: 'cc-d1', facts: [{ kind: 'task_op', data: { tool: 'tasks_context' } }] }, t);
    await post('/turn/prompt', { agent_session_id: 'cc-d1' }, t);
    await post('/activity', { agent_session_id: 'cc-d1', facts: [{ kind: 'git_commit', data: { sha, subject: 'x' } }] }, t);
    expect(await (await post('/turn/stop', { agent_session_id: 'cc-d1' }, t)).json()).toEqual({ action: 'ok' });
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM nudges WHERE session_id = $1`, [session.id]);
    expect(rows[0].n).toBe(1);
  });

  it('turn/stop takes git_commit facts only', async () => {
    await post('/session/start', { agent_session_id: 'cc-sfk', cwd: '.', repo });
    const r = await post('/turn/stop', { agent_session_id: 'cc-sfk', facts: [{ kind: 'file_edit', data: { path: 'a.ts' } }] });
    expect(r.status).toBe(400);
  });

  it('rejects malformed facts', async () => {
    const r = await post('/activity', { agent_session_id: 'cc-1', facts: [{ kind: 'git_commit', data: { sha: 'zz', subject: 'x' } }] });
    expect(r.status).toBe(400);
  });
});

describe('body limit on /api/* (1 MB)', () => {
  const big = (fields: Record<string, unknown>) => JSON.stringify({ ...fields, pad: 'x'.repeat(1_100_000) });
  const raw = (path: string, body: string, headers: Record<string, string> = {}) =>
    app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });

  it('answers a body over 1 MB with a JSON 413 on hooks and UI routes', async () => {
    const hooks = await raw('/api/hooks/activity', big({ agent_session_id: 'x', facts: [] }), { Authorization: `Bearer ${token}` });
    expect(hooks.status).toBe(413);
    expect(await hooks.json()).toEqual({ error: { code: 'payload_too_large', message: 'Request body too large (max 1 MB).' } });
    const ui = await raw('/api/ui/login', big({ password: 'x' }));
    expect(ui.status).toBe(413);
    expect(((await ui.json()) as { error: { code: string } }).error.code).toBe('payload_too_large');
  });

  it('the largest activity batch conus builds (200 facts, 500-char paths of 3-byte characters) stays well under it', async () => {
    await post('/session/start', { agent_session_id: 'cc-big', cwd: '.', repo });
    const facts = Array.from({ length: 200 }, (_, i) => ({ kind: 'file_edit', data: { path: `${String(i).padStart(3, '0')}/${'中'.repeat(496)}` } }));
    const body = { agent_session_id: 'cc-big', facts, idempotency_key: 'k'.repeat(40) };
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(400_000);
    expect((await post('/activity', body)).status).toBe(204);
  });
});

describe('per-agent rate limit (spec §11)', () => {
  it('over the limit every hooks route answers 429 rate_limited, per agent token', async () => {
    const limited = createApp({ db, judge: new NullJudge(), agentLimiter: new RateLimiter(3, 60_000) });
    const { token: a } = await createAgent(db, { name: 'rl-hooks-a', kind: 'claude_code' });
    const { token: b } = await createAgent(db, { name: 'rl-hooks-b', kind: 'claude_code' });
    const who = (t: string) => limited.request('/api/hooks/whoami', { headers: { Authorization: `Bearer ${t}` } });
    const send = (path: string, body: unknown, t: string) => limited.request(`/api/hooks${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    // a bad token is refused before the limiter and never spends anyone's budget
    expect((await who('tm_bad')).status).toBe(401);
    for (let i = 0; i < 3; i++) expect((await who(a)).status).toBe(200);
    const over = await who(a);
    expect(over.status).toBe(429);
    expect(((await over.json()) as { error: { code: string } }).error.code).toBe('rate_limited');
    expect((await send('/activity', { agent_session_id: 'x', facts: [] }, a)).status).toBe(429);
    expect((await send('/session/start', { agent_session_id: 'x', cwd: '.', repo }, a)).status).toBe(429);
    expect((await who(b)).status).toBe(200);
  });
});

describe('stop check fails open', () => {
  it('returns {action: ok} with 200 and logs when the stop check throws', async () => {
    // evaluateStop reads judge.enabled after the D1 check; a throwing getter makes evaluateStop itself throw
    // (judge.evaluate failures are already swallowed inside core, so they would not exercise the route).
    const exploding: Judge = {
      get enabled(): boolean { throw new Error('stop check exploded'); },
      evaluate: async () => OK_VERDICT,
      summarize: async () => null,
    };
    const failing = createApp({ db, judge: exploding });
    const send = (path: string, body: unknown) =>
      failing.request(`/api/hooks${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await send('/session/start', { agent_session_id: 'cc-fail', cwd: '/w/hooks', repo })).status).toBe(200);

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = await send('/turn/stop', { agent_session_id: 'cc-fail', stop_hook_active: false });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ action: 'ok' });
      expect(errors).toHaveBeenCalledWith('[hooks] stop check failed', expect.objectContaining({ message: 'stop check exploded' }));
    } finally {
      errors.mockRestore();
    }
  });
});
