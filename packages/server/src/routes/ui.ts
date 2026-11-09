import {
  agentHealthRollup, claimOwner, createAgent, createOwnerSession, deleteOwnerSession, dropTask, getOverview, getSessionOverview, getTaskById, getTaskDetail,
  getProjectByKey, hasOwner, healthWarnings, listAgents, listProjects, listSessionSummaries, listTasks, mergeDuplicate, mergeProjects,
  ownerEditTask, ownerMoveTask, ownerSetPlanning, ownerSetStatus, renameProject, revokeAgent, softDeleteTask, updateTask, validateOwnerSession,
  NullManagerLlm, createTelegramLinkCode, getSettings, latestReview, runIntake, runReview, unlinkTelegram, updateSettings, INTAKE_MAX_CHARS,
  t as tr, verifyOwnerPassword, DomainError, PRIORITIES, STATUSES, type Ctx, type Status,
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

  // every project at a glance, and what waits for the owner
  r.get('/overview', async (c) => c.json(await getOverview(db)));

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
  // priority and due date; `due_on: null` clears the date
  r.patch('/tasks/:id/planning', async (c) => {
    const taskId = idParam(c, 'Task');
    const b = parseWith(z.object({ priority: z.enum(PRIORITIES).optional(), due_on: z.string().max(10).nullable().optional() }), await c.req.json());
    return c.json(await ownerSetPlanning(user(), { taskId, priority: b.priority, dueOn: b.due_on }));
  });
  r.post('/tasks/:id/status', async (c) => {
    const taskId = idParam(c, 'Task');
    const b = parseWith(z.object({ status: z.enum(STATUSES), reason: z.string().max(1000).optional() }), await c.req.json());
    return c.json(await ownerSetStatus(user(), { taskId, status: b.status, reason: b.reason }));
  });
  r.post('/tasks/:id/move', async (c) => {
    const taskId = idParam(c, 'Task');
    const { project_id } = parseWith(z.object({ project_id: z.string().uuid() }), await c.req.json());
    return c.json(await ownerMoveTask(user(), { taskId, projectId: project_id }));
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

  // ── the manager: settings, Telegram, correspondence, reviews ──
  const llm = deps.manager?.llm ?? new NullManagerLlm();
  // every intake or review is a paid model call: a generous cap that still stops a runaway script
  const spend = new RateLimiter(40, 3_600_000);
  const spendOk = (c: Context) => (spend.hit('owner') ? null : tooMany(c));
  const managerState = () => ({
    telegram: {
      configured: !!deps.manager?.telegram.configured,
      botUsername: deps.manager?.telegram.username ?? null,
      error: deps.manager?.telegram.error ?? null,
    },
    manager: { enabled: llm.enabled, model: llm.enabled ? llm.model : null },
  });
  const settingsBody = async () => {
    const s = await getSettings(db);
    const { lastDigestOn: _d, lastReviewOn: _r, lastReminderAt: _m, remindersMuted: _q, telegramChatId, ...rest } = s;
    return { settings: { ...rest, telegramLinked: telegramChatId != null }, ...managerState() };
  };
  r.get('/settings', async (c) => c.json(await settingsBody()));
  r.patch('/settings', async (c) => {
    const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
    const b = parseWith(z.object({
      time_zone: z.string().max(64).optional(), digest_time: time.optional(), quiet_from: time.optional(), quiet_to: time.optional(),
      notify_review: z.boolean().optional(), notify_blocked: z.boolean().optional(), manager_auto: z.boolean().optional(),
      remind_every_hours: z.number().int().min(0).max(24).optional(),
    }), await c.req.json());
    await updateSettings(db, {
      timeZone: b.time_zone, digestTime: b.digest_time, quietFrom: b.quiet_from, quietTo: b.quiet_to,
      notifyReview: b.notify_review, notifyBlocked: b.notify_blocked, managerAuto: b.manager_auto, remindEveryHours: b.remind_every_hours,
    });
    return c.json(await settingsBody());
  });
  r.post('/telegram/link', async (c) => {
    const username = deps.manager?.telegram.username;
    if (!deps.manager?.api || !username) {
      throw new DomainError('unavailable', 'The Telegram bot is not running: set CONUS_TELEGRAM_BOT_TOKEN on the server.', { reason: 'telegram_off' });
    }
    const { code, expiresAt } = await createTelegramLinkCode(db);
    return c.json({ code, url: `https://t.me/${username}?start=${code}`, expiresAt });
  });
  r.post('/telegram/unlink', async (c) => {
    await unlinkTelegram(db);
    return c.json(await settingsBody());
  });
  r.post('/telegram/test', async (c) => {
    const chat = (await getSettings(db)).telegramChatId;
    if (!deps.manager?.api || chat == null) throw new DomainError('unavailable', 'Telegram is not linked.', { reason: 'telegram_off' });
    await deps.manager.api.sendMessage(chat, tr('👋 <b>Conus is here.</b>\nDigests, reminders and notices will come to this chat. /help — what I can do.',
      '👋 <b>Conus на связи.</b>\nСводки, напоминания и уведомления будут приходить сюда. /help — что я умею.'));
    return c.json({ ok: true });
  });
  r.post('/intake', async (c) => {
    const limited = spendOk(c);
    if (limited) return limited;
    const { text } = parseWith(z.object({ text: z.string().max(INTAKE_MAX_CHARS + 1000) }), await c.req.json());
    return c.json({ batch: await runIntake({ db, llm }, { source: 'web', text }) });
  });
  r.get('/manager/review', async (c) => c.json({ review: await latestReview(db), ...managerState() }));
  r.post('/manager/review', async (c) => {
    const limited = spendOk(c);
    if (limited) return limited;
    return c.json({ review: await runReview({ db, llm }, 'owner'), ...managerState() });
  });
  return r;
}
