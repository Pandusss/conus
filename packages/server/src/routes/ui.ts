import {
  agentHealthRollup, claimOwner, createAgent, createOwnerSession, deleteOwnerSession, dropTask, getSessionOverview, getTaskById, getTaskDetail,
  getProjectByKey, hasOwner, healthWarnings, listAgents, listProjects, listSessionSummaries, listTasks, mergeDuplicate, mergeProjects,
  ownerEditTask, ownerSetStatus, renameProject, revokeAgent, softDeleteTask, updateTask, validateOwnerSession,
  t as tr, verifyOwnerPassword, DomainError, STATUSES, type Ctx, type Status,
} from '@conus/core';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { clientKey, RateLimiter } from '../rate-limit';
import { setupCodeMatches } from '../setup-code';
import { parseWith } from '../validate';

const SESSION_COOKIE = 'conus_session';
const CSRF_COOKIE = 'conus_csrf';
const MAX_AGE = 30 * 86_400;

/** Positive integer query param capped at `max`; anything else (missing, NaN, ≤ 0) falls back to `def`. */
function limitParam(v: string | undefined, def: number, max: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `:id` path param; anything that is not a UUID cannot exist, so it is a 404 rather than a Postgres cast error. */
function idParam(c: Context, entity: string): string {
  const id = c.req.param('id') ?? '';
  if (!UUID_RE.test(id)) throw new DomainError('not_found', `${entity} not found.`);
  return id;
}

export function uiRoutes(deps: AppDeps) {
  const { db } = deps;
  const secure = !!deps.cookieSecure;
  const limiter = new RateLimiter(10, 60_000);
  const r = new Hono();
  const user = (): Ctx => ({ db, actor: { kind: 'user' } });

  const tooMany = (c: Context) => c.json({ error: { code: 'rate_limited', message: 'Too many attempts, wait a minute.' } }, 429);
  const startOwnerSession = async (c: Context) => {
    const token = await createOwnerSession(db);
    setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: 'Strict', secure, path: '/', maxAge: MAX_AGE });
    setCookie(c, CSRF_COOKIE, randomBytes(24).toString('base64url'), { httpOnly: false, sameSite: 'Strict', secure, path: '/', maxAge: MAX_AGE });
    return c.json({ ok: true });
  };

  r.post('/login', async (c) => {
    if (!limiter.hit(clientKey(c.req.header('x-forwarded-for')))) return tooMany(c);
    const { password } = parseWith(z.object({ password: z.string().max(500) }), await c.req.json());
    if (!(await verifyOwnerPassword(db, password))) return c.json({ error: { code: 'unauthorized', message: 'Wrong password.' } }, 401);
    return startOwnerSession(c);
  });

  // First run: no owner yet. The setup code (server log or CONUS_SETUP_CODE) keeps a stranger who reaches a fresh
  // public server first from claiming it.
  r.get('/setup', async (c) => c.json({ needed: !(await hasOwner(db)) }));
  r.post('/setup', async (c) => {
    if (!limiter.hit(clientKey(c.req.header('x-forwarded-for')))) return tooMany(c);
    const { code, password } = parseWith(z.object({ code: z.string().max(100), password: z.string().max(500) }), await c.req.json());
    const done = () => c.json({ error: { code: 'already_set_up', message: 'Conus is already set up: log in.' } }, 409);
    if (await hasOwner(db)) return done();
    if (!deps.setupCode || !setupCodeMatches(code, deps.setupCode)) return c.json({ error: { code: 'wrong_setup_code', message: 'Wrong setup code.' } }, 403);
    if (!(await claimOwner(db, password))) return done();
    return startOwnerSession(c);
  });

  r.get('/me', async (c) => c.json({ authenticated: await validateOwnerSession(db, getCookie(c, SESSION_COOKIE) ?? '') }));

  r.use('*', async (c, next) => {
    if (!(await validateOwnerSession(db, getCookie(c, SESSION_COOKIE) ?? ''))) {
      return c.json({ error: { code: 'unauthorized', message: 'Log in first.' } }, 401);
    }
    if (c.req.method !== 'GET') {
      const header = c.req.header('x-csrf-token');
      const cookie = getCookie(c, CSRF_COOKIE);
      if (!header || !cookie || header !== cookie) return c.json({ error: { code: 'forbidden', message: 'CSRF check failed.' } }, 403);
    }
    await next();
  });

  r.post('/logout', async (c) => {
    await deleteOwnerSession(db, getCookie(c, SESSION_COOKIE) ?? '');
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    deleteCookie(c, CSRF_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  // projects
  r.get('/projects', async (c) => c.json({ projects: await listProjects(db) }));
  r.patch('/projects/:id', async (c) => {
    const id = idParam(c, 'Project');
    const { name } = parseWith(z.object({ name: z.string() }), await c.req.json());
    return c.json({ project: await renameProject(db, id, name) });
  });
  r.post('/projects/:id/merge', async (c) => {
    const id = idParam(c, 'Project');
    const { into_id } = parseWith(z.object({ into_id: z.string().uuid() }), await c.req.json());
    await mergeProjects(db, id, into_id);
    return c.json({ ok: true });
  });

  // tasks
  r.get('/tasks', async (c) => {
    const key = c.req.query('project');
    const project = key ? await getProjectByKey(db, key) : null;
    if (key && !project) throw new DomainError('not_found', `Project ${key} not found.`);
    const statuses = (c.req.query('status') ?? '').split(',').filter((s): s is Status => (STATUSES as readonly string[]).includes(s));
    const tasks = await listTasks(db, { projectId: project?.id, statuses, query: c.req.query('q') ?? null, limit: limitParam(c.req.query('limit'), 500, 1000) });
    return c.json({ tasks });
  });
  r.get('/tasks/:id', async (c) => {
    const d = await getTaskDetail(db, idParam(c, 'Task'));
    if (!d) throw new DomainError('not_found', 'Task not found.');
    return c.json(d);
  });
  r.patch('/tasks/:id', async (c) => {
    const taskId = idParam(c, 'Task');
    const b = parseWith(z.object({ title: z.string().optional(), description: z.string().optional(), expected_version: z.number().int() }), await c.req.json());
    return c.json(await ownerEditTask(user(), { taskId, title: b.title, description: b.description, expectedVersion: b.expected_version }));
  });
  r.post('/tasks/:id/status', async (c) => {
    const taskId = idParam(c, 'Task');
    const b = parseWith(z.object({ status: z.enum(STATUSES), reason: z.string().max(1000).optional() }), await c.req.json());
    return c.json(await ownerSetStatus(user(), { taskId, status: b.status, reason: b.reason }));
  });
  r.post('/tasks/:id/merge', async (c) => {
    const duplicateId = idParam(c, 'Task');
    const { into_id } = parseWith(z.object({ into_id: z.string().uuid() }), await c.req.json());
    return c.json(await mergeDuplicate(user(), { duplicateId, intoId: into_id }));
  });
  r.delete('/tasks/:id', async (c) => {
    await softDeleteTask(user(), { taskId: idParam(c, 'Task') });
    return c.json({ ok: true });
  });

  // proposals
  const proposal = async (c: Context) => {
    const t = await getTaskById(db, idParam(c, 'Proposal'));
    if (!t || t.deletedAt) throw new DomainError('not_found', 'Proposal not found.');
    return t;
  };
  r.post('/proposals/:id/accept', async (c) => {
    const t = await proposal(c);
    return c.json(await updateTask(user(), { projectId: t.projectId, task: t.ref, promote: true }));
  });
  r.post('/proposals/:id/reject', async (c) => {
    const t = await proposal(c);
    if (t.status !== 'proposed') {
      throw new DomainError('invalid_transition', `${t.ref} is not a proposal (status ${t.status}).`, { current: t.status });
    }
    const body = await c.req.json().catch(() => ({}));
    const { reason } = parseWith(z.object({ reason: z.string().max(900).optional() }), body);
    return c.json(await dropTask(user(), { projectId: t.projectId, task: t.ref, reason: reason?.trim() ? `${tr('Rejected', 'Отклонено')}: ${reason.trim()}` : tr('Rejected by the owner', 'Отклонено владельцем') }));
  });

  // sessions
  r.get('/sessions', async (c) => c.json({ sessions: await listSessionSummaries(db, limitParam(c.req.query('limit'), 50, 200)) }));
  r.get('/sessions/:id', async (c) => {
    const o = await getSessionOverview(db, idParam(c, 'Session'));
    if (!o) throw new DomainError('not_found', 'Session not found.');
    return c.json(o);
  });

  // agents
  r.get('/agents', async (c) => {
    const [agents, rollup] = await Promise.all([listAgents(db), agentHealthRollup(db)]);
    const stats = new Map(rollup.map(({ agentId, ...s }) => [agentId, s]));
    const zero = { sessions: 0, nudges: 0, nudgesActed: 0, janitorReleases: 0 };
    return c.json({ agents: agents.map((a) => ({ ...a, stats: stats.get(a.id) ?? zero })) });
  });
  r.post('/agents', async (c) => {
    const b = parseWith(z.object({ name: z.string(), kind: z.enum(['claude_code', 'codex', 'other']) }), await c.req.json());
    return c.json(await createAgent(db, b));
  });
  r.post('/agents/:id/revoke', async (c) => {
    await revokeAgent(db, idParam(c, 'Agent'));
    return c.json({ ok: true });
  });

  r.get('/health', async (c) => c.json({ warnings: await healthWarnings(db) }));
  return r;
}
