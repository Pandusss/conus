import {
  beginTurn, endSessionOnce, evaluateStop, getProjectById, getSessionByAgentSessionId, recordExcerpt, recordHookActivity,
  renderSessionContext, renderStatusLine, setSessionModel, startSession, touchSession, type Fact,
} from '@conus/core';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps, AppEnv } from '../app';
import { agentAuth } from '../auth';
import { AGENT_RATE_LIMITED_MESSAGE, agentRateLimiter } from '../rate-limit';
import { parseWith } from '../validate';

const GitCommitFact = z.object({
  kind: z.literal('git_commit'),
  // amends: the HEAD this commit replaced (git commit --amend); its link is swapped for this one.
  data: z.object({
    sha: z.string().regex(/^[0-9a-f]{7,40}$/i), subject: z.string().max(300), branch: z.string().max(200).optional(),
    amends: z.string().regex(/^[0-9a-f]{7,40}$/i).optional(),
  }),
});

export const FactSchema: z.ZodType<Fact> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file_edit'), data: z.object({ path: z.string().min(1).max(500) }) }),
  GitCommitFact,
  z.object({ kind: z.literal('test_run'), data: z.object({ passed: z.boolean().nullable(), command: z.string().max(300) }) }),
  z.object({ kind: z.literal('task_op'), data: z.object({ tool: z.string().max(50), task: z.string().max(30).optional() }) }),
]) as z.ZodType<Fact>;

const sid = z.string().min(1).max(200);
export const StartBody = z.object({
  agent_session_id: sid,
  source: z.enum(['startup', 'resume', 'clear', 'compact']).default('startup'),
  cwd: z.string().min(1).max(1000),
  repo: z.object({
    remote: z.string().max(500).nullish(),
    root_name: z.string().min(1).max(200),
    root_path_hash: z.string().min(1).max(128),
    branch: z.string().max(200).nullish(),
    head: z.string().max(64).nullish(),
  }),
  model: z.string().max(100).nullish(),
});
export const PromptBody = z.object({ agent_session_id: sid, prompt_excerpt: z.string().max(20_000).nullish() });
export const ActivityBody = z.object({ agent_session_id: sid, facts: z.array(FactSchema).max(200), idempotency_key: z.string().max(200).nullish() });
export const StopBody = z.object({
  agent_session_id: sid, stop_hook_active: z.boolean().default(false), answer_excerpt: z.string().max(20_000).nullish(),
  // Claude Code's SessionStart carries no model; conus hook reports it from the transcript at Stop.
  model: z.string().max(100).nullish(),
  // A commit that moved HEAD since conus's last report (its async PostToolUse fact may still be on the way).
  facts: z.array(GitCommitFact).max(10).optional(),
});
export const EndBody = z.object({ agent_session_id: sid, reason: z.string().max(100).nullish(), idempotency_key: z.string().max(200).nullish() });

export function hooksRoutes(deps: AppDeps): Hono<AppEnv> {
  const { db, judge } = deps;
  const limiter = deps.agentLimiter ?? agentRateLimiter();
  const r = new Hono<AppEnv>();
  r.use('*', agentAuth(db));
  // Spec §11: per agent token, after authentication (a bad token never spends an agent's budget). conus queues 429s.
  r.use('*', async (c, next) => {
    if (!limiter.hit(c.get('agent').id)) return c.json({ error: { code: 'rate_limited', message: AGENT_RATE_LIMITED_MESSAGE } }, 429);
    await next();
  });

  r.get('/whoami', (c) => {
    const a = c.get('agent');
    return c.json({ agent: { name: a.name, kind: a.kind } });
  });

  r.post('/session/start', async (c) => {
    const agent = c.get('agent');
    const b = parseWith(StartBody, await c.req.json());
    const { session, project } = await startSession(db, {
      agentId: agent.id, agentSessionId: b.agent_session_id, source: b.source, cwd: b.cwd, model: b.model ?? null,
      repo: { remote: b.repo.remote ?? null, rootName: b.repo.root_name, rootPathHash: b.repo.root_path_hash, branch: b.repo.branch ?? null, head: b.repo.head ?? null },
    });
    const context = await renderSessionContext(db, { session, project, agentName: agent.name });
    return c.json({ enabled: true, session_ref: session.ref, project_key: project.key, context });
  });

  r.post('/turn/prompt', async (c) => {
    const agent = c.get('agent');
    const b = parseWith(PromptBody, await c.req.json());
    const s = await getSessionByAgentSessionId(db, agent.id, b.agent_session_id);
    if (!s || !s.projectId) return c.json({ status_line: '' });
    await beginTurn(db, s.id);
    if (b.prompt_excerpt) await recordExcerpt(db, s.id, 'prompt_excerpt', b.prompt_excerpt);
    await touchSession(db, s.id);
    const project = await getProjectById(db, s.projectId);
    return c.json({ status_line: await renderStatusLine(db, s, project?.key ?? '?') });
  });

  r.post('/activity', async (c) => {
    const agent = c.get('agent');
    const b = parseWith(ActivityBody, await c.req.json());
    const s = await getSessionByAgentSessionId(db, agent.id, b.agent_session_id);
    // Not a drop: the session's session/start may still sit in conus's outbox. conus keeps the facts and retries them
    // after the start got through (a plain 409 would be a permanent rejection).
    if (!s) return c.json({ error: { code: 'unknown_session', message: 'Unknown session: send session/start first, then retry.' } }, 409);
    await recordHookActivity(db, { agentId: agent.id, sessionId: s.id, idempotencyKey: b.idempotency_key ?? null, facts: b.facts });
    return c.body(null, 204);
  });

  r.post('/turn/stop', async (c) => {
    const agent = c.get('agent');
    const b = parseWith(StopBody, await c.req.json());
    const found = await getSessionByAgentSessionId(db, agent.id, b.agent_session_id);
    if (!found) return c.json({ action: 'ok' });
    await touchSession(db, found.id);
    try {
      // Stored before the Stop check, so commits it links (and later MCP calls) carry the model.
      let s = found;
      if (b.model && b.model !== found.model) {
        await setSessionModel(db, found.id, b.model);
        s = { ...found, model: b.model };
      }
      // Into the current turn before the check; a commit already recorded for the session is not recorded again.
      if (b.facts?.length) await recordHookActivity(db, { agentId: agent.id, sessionId: found.id, facts: b.facts as Fact[] });
      const decision = await evaluateStop({ db, judge }, { session: s, stopHookActive: b.stop_hook_active, answerExcerpt: b.answer_excerpt ?? null });
      return c.json(decision);
    } catch (e) {
      // The Stop check fails open: a failure here (e.g. linkCommit not_found on a concurrently deleted task)
      // must never block the agent.
      console.error('[hooks] stop check failed', e);
      return c.json({ action: 'ok' });
    }
  });

  r.post('/session/end', async (c) => {
    const agent = c.get('agent');
    const b = parseWith(EndBody, await c.req.json());
    const s = await getSessionByAgentSessionId(db, agent.id, b.agent_session_id);
    if (s) await endSessionOnce(db, { agentId: agent.id, sessionId: s.id, idempotencyKey: b.idempotency_key ?? null, reason: b.reason ?? null });
    return c.body(null, 204);
  });

  return r;
}
