import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../../../test/helpers/db';
import { seedAgentSession } from '../../../test/helpers/fixtures';
import { createTask, NullJudge, proposeTask, setOwnerPassword, type Db } from './test-imports';
import { createApp } from '../src/app';

let db: Db; let drop: () => Promise<void>;
let app: ReturnType<typeof createApp>;
let cookie = ''; let csrf = '';
beforeAll(async () => {
  ({ db, drop } = await createTestDb());
  app = createApp({ db, judge: new NullJudge() });
  await setOwnerPassword(db, 'owner-password-1');
});
afterAll(async () => drop());

// Node's Response.json() is typed Promise<unknown>; the assertions below read response bodies loosely.
type JsonResponse = Omit<Response, 'json'> & { json(): Promise<any> };
async function req(path: string, init: RequestInit & { json?: unknown } = {}): Promise<JsonResponse> {
  const headers: Record<string, string> = { cookie, ...(init.headers as Record<string, string>) };
  if (init.json !== undefined) headers['content-type'] = 'application/json';
  return app.request(`/api/ui${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
}
const mutate = (path: string, method: string, json?: unknown) => req(path, { method, json, headers: { 'x-csrf-token': csrf } });

describe('UI API', () => {
  it('requires login; wrong password is 401; login sets cookies', async () => {
    expect((await req('/tasks')).status).toBe(401);
    expect(await (await req('/me')).json()).toEqual({ authenticated: false });
    expect((await req('/login', { method: 'POST', json: { password: 'nope-nope' } })).status).toBe(401);
    const r = await req('/login', { method: 'POST', json: { password: 'owner-password-1' } });
    expect(r.status).toBe(200);
    const set = r.headers.getSetCookie();
    const session = set.find((c) => c.startsWith('conus_session='))!;
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Strict/i);
    csrf = set.find((c) => c.startsWith('conus_csrf='))!.split(';')[0]!.split('=')[1]!;
    cookie = set.map((c) => c.split(';')[0]).join('; ');
    expect(await (await req('/me')).json()).toEqual({ authenticated: true });
  });

  it('enforces CSRF on mutations', async () => {
    expect((await req('/agents', { method: 'POST', json: { name: 'x', kind: 'codex' } })).status).toBe(403);
  });

  it('agents: create returns token once, revoke', async () => {
    const r = await mutate('/agents', 'POST', { name: 'claude-code@laptop', kind: 'claude_code' });
    const j = await r.json();
    expect(j.token).toMatch(/^conus_/);
    const list = await (await req('/agents')).json();
    expect(JSON.stringify(list)).not.toContain(j.token);
    const listed = list.agents.find((a: any) => a.id === j.agent.id);
    expect(listed).toMatchObject({ name: 'claude-code@laptop', stats: { sessions: 0, nudges: 0, nudgesActed: 0, janitorReleases: 0 } });
    expect((await mutate(`/agents/${j.agent.id}/revoke`, 'POST')).status).toBe(200);
  });

  it('tasks: list/filter, detail, status, edit with version conflict, proposals accept/reject, merge', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/ui.git' });
    const a = await createTask({ db, actor: s.actor }, { projectId: s.project.id, title: 'Board item' });
    const p1 = await proposeTask({ db, actor: s.actor }, { projectId: s.project.id, title: 'Idea to accept', sourceQuote: 'q' });
    const p2 = await proposeTask({ db, actor: s.actor }, { projectId: s.project.id, title: 'Other idea entirely', sourceQuote: 'q', confirmNew: { reason: 't' } });
    if (a.outcome !== 'created' || p1.outcome !== 'created' || p2.outcome !== 'created') throw new Error();

    const list = await (await req(`/tasks?project=${s.project.key}&status=proposed`)).json();
    expect(list.tasks.map((t: any) => t.title).sort()).toEqual(['Idea to accept', 'Other idea entirely']);

    const detail = await (await req(`/tasks/${a.task.id}`)).json();
    expect(detail.task.ref).toBe(a.task.ref);
    expect(detail.events[0].type).toBe('created');

    expect((await mutate(`/tasks/${a.task.id}`, 'PATCH', { title: 'Renamed', expected_version: 99 })).status).toBe(409);
    expect((await mutate(`/tasks/${a.task.id}`, 'PATCH', { title: 'Renamed', expected_version: a.task.version })).status).toBe(200);
    const st = await (await mutate(`/tasks/${a.task.id}/status`, 'POST', { status: 'done' })).json();
    expect(st.task.status).toBe('done');

    expect((await (await mutate(`/proposals/${p1.task.id}/accept`, 'POST')).json()).task.status).toBe('todo');
    const rej = await (await mutate(`/proposals/${p2.task.id}/reject`, 'POST', { reason: 'не нужно' })).json();
    expect(rej.task.status).toBe('dropped');

    const merged = await (await mutate(`/tasks/${p2.task.id}/merge`, 'POST', { into_id: p1.task.id })).json();
    expect(merged.task.id).toBe(p1.task.id);

    // Reject is for proposals only: p1 is now todo, `a` is done.
    for (const id of [p1.task.id, a.task.id]) {
      const r = await mutate(`/proposals/${id}/reject`, 'POST', { reason: 'нет' });
      expect(r.status).toBe(409);
      expect((await r.json()).error).toMatchObject({ code: 'invalid_transition', details: { current: id === a.task.id ? 'done' : 'todo' } });
    }
    expect((await (await req(`/tasks/${p1.task.id}`)).json()).task.status).toBe('todo');
  });

  it('task list and detail carry the board extras: project name, holder, subtask and commit counts', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/ui-view.git' });
    const parent = await createTask({ db, actor: s.actor }, { projectId: s.project.id, title: 'Claimed parent', startNow: true });
    if (parent.outcome !== 'created') throw new Error();
    const kid = await createTask({ db, actor: s.actor }, { projectId: s.project.id, title: 'A child of it', parent: parent.task.ref, confirmNew: { reason: 't' } });
    if (kid.outcome !== 'created') throw new Error();
    await db.query(`INSERT INTO links(task_id, kind, ref, meta) VALUES ($1,'commit','beef001','{"subject":"feat: x"}')`, [parent.task.id]);

    const list = await (await req(`/tasks?project=${s.project.key}`)).json();
    const listed = list.tasks.find((t: any) => t.id === parent.task.id);
    expect(listed).toMatchObject({
      projectKey: s.project.key, projectName: s.project.name, subtaskCount: 1, commitCount: 1,
      holder: { agentName: s.agent.name, sessionRef: s.session.ref, sessionId: s.session.id },
    });
    expect(list.tasks.find((t: any) => t.id === kid.task.id)).toMatchObject({ holder: null, subtaskCount: 0, commitCount: 0 });

    const detail = await (await req(`/tasks/${parent.task.id}`)).json();
    expect(detail.task).toMatchObject({ projectName: s.project.name, subtaskCount: 1, commitCount: 1, holder: { sessionRef: s.session.ref } });
    expect(detail.subtasks).toHaveLength(1);
    expect(detail.subtasks[0]).toMatchObject({ id: kid.task.id, projectName: s.project.name, holder: null });
  });

  it('non-UUID path ids are 404 not_found, not 500', async () => {
    const get = async (path: string) => {
      const r = await req(path);
      return { status: r.status, code: (await r.json()).error?.code };
    };
    const post = async (path: string, json?: unknown) => {
      const r = await mutate(path, 'POST', json);
      return { status: r.status, code: (await r.json()).error?.code };
    };
    const notFound = { status: 404, code: 'not_found' };
    expect(await get('/tasks/WB-12')).toEqual(notFound);
    expect(await get('/sessions/s-123')).toEqual(notFound);
    expect(await post('/agents/nope/revoke')).toEqual(notFound);
    expect(await post('/proposals/WB-1/accept')).toEqual(notFound);
    expect(await post('/tasks/WB-1/status', { status: 'done' })).toEqual(notFound);
    const patch = await mutate('/projects/WB', 'PATCH', { name: 'x' });
    expect(patch.status).toBe(404);
    const del = await mutate('/tasks/1', 'DELETE');
    expect(del.status).toBe(404);
  });

  it('sessions, projects and health endpoints respond', async () => {
    expect((await (await req('/sessions')).json()).sessions.length).toBeGreaterThan(0);
    const projects = (await (await req('/projects')).json()).projects;
    expect(projects.length).toBeGreaterThan(0);
    expect((await mutate(`/projects/${projects[0].id}`, 'PATCH', { name: 'Renamed project' })).status).toBe(200);
    expect(await (await req('/health')).json()).toHaveProperty('warnings');
  });

  it('rate-limits login', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await app.request('/api/ui/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '9.9.9.9' }, body: JSON.stringify({ password: 'x' }) })).status;
    expect(last).toBe(429);
  });
});
