import { randomBytes } from 'node:crypto';
import { isUniqueViolation, withTx, type Db, type Queryable } from './db';
import { resolveOrCreateProject } from './projects';
import { mapSession } from './rows';
import type { Project, RepoInfo, Session, SessionSource } from './types';

export const CLAIM_TTL_MS = 30 * 60 * 1000;
export const STALE_AFTER_MS = 30 * 60 * 1000;

export interface StartSessionInput {
  agentId: string; agentSessionId: string; source: SessionSource; cwd: string; repo: RepoInfo; model?: string | null;
}

function newRef(bytes: number): string {
  return 'S-' + randomBytes(bytes).toString('hex');
}

export async function startSession(db: Db, input: StartSessionInput): Promise<{ session: Session; project: Project }> {
  const { project } = await resolveOrCreateProject(db, input.repo);
  for (let attempt = 0; attempt < 8; attempt++) {
    const ref = newRef(attempt < 5 ? 2 : 3);
    try {
      const { rows } = await db.query(
        `INSERT INTO sessions(ref, agent_id, agent_session_id, project_id, cwd, branch, model)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (agent_id, agent_session_id) DO UPDATE SET
           project_id = EXCLUDED.project_id, cwd = EXCLUDED.cwd, branch = EXCLUDED.branch,
           model = COALESCE(EXCLUDED.model, sessions.model), state = 'active', ended_at = NULL,
           end_reason = NULL, last_seen_at = now()
         RETURNING *`,
        [ref, input.agentId, input.agentSessionId, project.id, input.cwd, input.repo.branch ?? null, input.model ?? null],
      );
      const session = mapSession(rows[0]);
      await touchSession(db, session.id);
      return { session, project };
    } catch (e) {
      if (isUniqueViolation(e)) continue; // ref collision, retry
      throw e;
    }
  }
  throw new Error('Could not allocate a session ref');
}

export async function getSessionById(q: Queryable, id: string): Promise<Session | null> {
  const { rows } = await q.query('SELECT * FROM sessions WHERE id = $1', [id]);
  return rows[0] ? mapSession(rows[0]) : null;
}

export async function getSessionByRef(q: Queryable, ref: string): Promise<Session | null> {
  const { rows } = await q.query('SELECT * FROM sessions WHERE ref = $1', [ref]);
  return rows[0] ? mapSession(rows[0]) : null;
}

export async function getSessionByAgentSessionId(q: Queryable, agentId: string, agentSessionId: string): Promise<Session | null> {
  const { rows } = await q.query('SELECT * FROM sessions WHERE agent_id = $1 AND agent_session_id = $2', [agentId, agentSessionId]);
  return rows[0] ? mapSession(rows[0]) : null;
}

export async function touchSession(q: Queryable, sessionId: string, now = new Date()): Promise<void> {
  await q.query(
    `UPDATE sessions SET last_seen_at = $2, state = CASE WHEN state = 'stale' THEN 'active' ELSE state END WHERE id = $1`,
    [sessionId, now],
  );
  await q.query(
    `UPDATE tasks SET claim_expires_at = $2 WHERE claimed_by_session_id = $1 AND status = 'in_progress'`,
    [sessionId, new Date(now.getTime() + CLAIM_TTL_MS)],
  );
}

export async function beginTurn(q: Queryable, sessionId: string): Promise<number> {
  const { rows } = await q.query('UPDATE sessions SET current_turn = current_turn + 1 WHERE id = $1 RETURNING current_turn', [sessionId]);
  return rows[0]?.current_turn ?? 0;
}

/**
 * Stores the model a hook reported after the session started (Claude Code's SessionStart carries none, so
 * the model comes from the transcript at Stop). Returns true when the stored value changed.
 */
export async function setSessionModel(q: Queryable, sessionId: string, model: string): Promise<boolean> {
  const r = await q.query('UPDATE sessions SET model = $2 WHERE id = $1 AND model IS DISTINCT FROM $2', [sessionId, model]);
  return (r.rowCount ?? 0) > 0;
}

export async function endSession(q: Queryable, sessionId: string, reason: string | null): Promise<void> {
  await q.query(
    `UPDATE sessions SET state = 'ended', ended_at = now(), end_reason = $2, last_seen_at = now() WHERE id = $1`,
    [sessionId, reason],
  );
}

/**
 * An Mcp-Session-Id is bound to at most one session per agent: the latest binding wins, so it is
 * removed from the agent's other sessions before being appended to this one. The advisory lock
 * serializes concurrent rebinds of the same id (READ COMMITTED would otherwise leave it on two rows).
 */
async function bindMcp(q: Queryable, agentId: string, sessionId: string, mcpSessionId: string | null | undefined): Promise<void> {
  if (!mcpSessionId) return;
  await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`mcp:${agentId}:${mcpSessionId}`]);
  await q.query(
    `UPDATE sessions SET mcp_session_ids = array_remove(mcp_session_ids, $3)
     WHERE agent_id = $1 AND id <> $2 AND $3 = ANY(mcp_session_ids)`,
    [agentId, sessionId, mcpSessionId],
  );
  await q.query(
    `UPDATE sessions SET mcp_session_ids = array_append(mcp_session_ids, $2)
     WHERE id = $1 AND NOT ($2 = ANY(mcp_session_ids))`,
    [sessionId, mcpSessionId],
  );
}

/**
 * Binds an MCP call to a session (spec §6), in order:
 * 1. the explicit `sessionRef` of one of the agent's sessions that has not ended;
 * 2. the session the Mcp-Session-Id is already bound to (not ended);
 * 3. the agent's single active session — when the call names a project (`projectId`), only if that session
 *    belongs to it, so a process without a session of its own (non-git dir, `conus disable`, failed start) never
 *    attaches to another project's session;
 * otherwise null (the call runs without a session and needs a project).
 */
export async function resolveSessionForMcp(
  db: Db,
  input: { agentId: string; sessionRef?: string | null; mcpSessionId?: string | null; projectId?: string | null },
): Promise<Session | null> {
  return withTx(db, async (tx) => {
    if (input.sessionRef) {
      // An ended session is never a target (same as rule 2): its ref falls through to the next rule.
      const { rows } = await tx.query(
        `SELECT * FROM sessions WHERE ref = $1 AND agent_id = $2 AND state <> 'ended'`, [input.sessionRef, input.agentId],
      );
      if (rows[0]) {
        await bindMcp(tx, input.agentId, rows[0].id, input.mcpSessionId);
        return mapSession(rows[0]);
      }
    }
    if (input.mcpSessionId) {
      // An ended session is never a binding target (e.g. /clear keeps the MCP connection but starts a
      // new agent session); stale ones stay eligible.
      const { rows } = await tx.query(
        `SELECT * FROM sessions WHERE agent_id = $1 AND $2 = ANY(mcp_session_ids) AND state <> 'ended'
         ORDER BY last_seen_at DESC LIMIT 1`,
        [input.agentId, input.mcpSessionId],
      );
      if (rows[0]) return mapSession(rows[0]);
    }
    const { rows } = await tx.query(`SELECT * FROM sessions WHERE agent_id = $1 AND state = 'active'`, [input.agentId]);
    if (rows.length === 1 && (!input.projectId || rows[0].project_id === input.projectId)) {
      await bindMcp(tx, input.agentId, rows[0].id, input.mcpSessionId);
      return mapSession(rows[0]);
    }
    return null;
  });
}
