import type { Queryable } from './db';
import { listTaskEvents } from './events';
import type { SessionState, TaskEvent } from './types';

/**
 * The web app words a warning in its own language from `kind` and the fields; `message` is the English text for
 * any other client. janitor_interventions also carries `count` (releases) and `days` (the window).
 */
export interface HealthWarning {
  kind: 'hooks_missing' | 'agent_silent' | 'janitor_interventions'; agentId: string; agentName: string; message: string;
  count?: number; days?: number;
}

/** Per-agent activity over the last `days` days (spec §9.3). */
export interface AgentHealthStats { agentId: string; sessions: number; nudges: number; nudgesActed: number; janitorReleases: number }

const HEALTH_WINDOW_DAYS = 7;
const JANITOR_WARN_THRESHOLD = 3;

/**
 * Every agent (revoked ones included) with its counts since `now - days`: sessions started, nudges (and how many
 * were acted on), and janitor releases, i.e. system `sent_to_review` / `claim_released` events whose
 * `changes.claimedBy.from` is the ref of one of the agent's sessions, plus backstop releases of unclaimed tasks
 * (system `claim_released` without `claimedBy`), counted for the agent whose event last put the task in progress.
 */
export async function agentHealthRollup(q: Queryable, now = new Date(), days = HEALTH_WINDOW_DAYS): Promise<AgentHealthStats[]> {
  const since = new Date(now.getTime() - days * 86_400_000);
  const { rows } = await q.query(
    `WITH sc AS (SELECT agent_id, count(*) AS n FROM sessions WHERE started_at >= $1 GROUP BY agent_id),
     nc AS (SELECT s.agent_id, count(*) AS n, count(*) FILTER (WHERE x.acted) AS acted
            FROM nudges x JOIN sessions s ON s.id = x.session_id WHERE x.created_at >= $1 GROUP BY s.agent_id),
     jr AS (SELECT s.agent_id
            FROM task_events e JOIN sessions s ON s.ref = e.changes->'claimedBy'->>'from'
            WHERE e.actor_kind = 'system' AND e.type IN ('sent_to_review','claim_released') AND e.created_at >= $1
            UNION ALL
            SELECT (SELECT x.actor_id FROM task_events x
                    WHERE x.task_id = e.task_id AND x.seq < e.seq AND x.actor_kind = 'agent'
                      AND (x.changes->'status'->>'to' = 'in_progress' OR x.type = 'claimed')
                    ORDER BY x.seq DESC LIMIT 1)
            FROM task_events e
            WHERE e.actor_kind = 'system' AND e.type = 'claim_released' AND NOT (e.changes ? 'claimedBy') AND e.created_at >= $1),
     jc AS (SELECT agent_id, count(*) AS n FROM jr WHERE agent_id IS NOT NULL GROUP BY agent_id)
     SELECT a.id, COALESCE(sc.n, 0) AS sessions, COALESCE(nc.n, 0) AS nudges, COALESCE(nc.acted, 0) AS nudges_acted,
       COALESCE(jc.n, 0) AS janitor_releases
     FROM agents a LEFT JOIN sc ON sc.agent_id = a.id LEFT JOIN nc ON nc.agent_id = a.id LEFT JOIN jc ON jc.agent_id = a.id
     ORDER BY a.created_at`,
    [since],
  );
  return rows.map((r) => ({
    agentId: r.id, sessions: r.sessions, nudges: r.nudges, nudgesActed: r.nudges_acted, janitorReleases: r.janitor_releases,
  }));
}

export async function healthWarnings(q: Queryable, now = new Date()): Promise<HealthWarning[]> {
  const day = new Date(now.getTime() - 86_400_000);
  const week = new Date(now.getTime() - 7 * 86_400_000);
  const out: HealthWarning[] = [];
  const rollup = new Map((await agentHealthRollup(q, now)).map((r) => [r.agentId, r]));
  // Hooks keep a session's last_seen_at fresh, so a long session started days ago still proves they work:
  // judging by started_at warned about an agent that merely stopped opening new sessions after one unbound call.
  const { rows } = await q.query(
    `SELECT a.id, a.name, a.last_seen_at, a.last_unbound_mcp_at,
       (SELECT max(last_seen_at) FROM sessions s WHERE s.agent_id = a.id) AS last_session
     FROM agents a WHERE a.revoked_at IS NULL ORDER BY a.name`,
  );
  for (const r of rows) {
    if (r.last_unbound_mcp_at && r.last_unbound_mcp_at > day && (!r.last_session || r.last_session < day)) {
      out.push({ kind: 'hooks_missing', agentId: r.id, agentName: r.name,
        message: `Agent ${r.name} calls MCP without registering a session — its hooks look missing or not approved. Run \`conus doctor\` on its machine.` });
    }
    if (r.last_seen_at && r.last_seen_at < week) {
      out.push({ kind: 'agent_silent', agentId: r.id, agentName: r.name, message: `Agent ${r.name} has not been in touch for more than 7 days.` });
    }
    const released = rollup.get(r.id)?.janitorReleases ?? 0;
    if (released >= JANITOR_WARN_THRESHOLD) {
      out.push({ kind: 'janitor_interventions', agentId: r.id, agentName: r.name, count: released, days: HEALTH_WINDOW_DAYS,
        message: `Agent ${r.name}: the server released its tasks ${released} ${released === 1 ? 'time' : 'times'} after its sessions in ${HEALTH_WINDOW_DAYS} days — the agent does not close its work itself.` });
    }
  }
  return out;
}

export interface SessionSummary {
  id: string; ref: string; agentName: string; projectKey: string | null; state: SessionState; branch: string | null;
  startedAt: Date; lastSeenAt: Date; endedAt: Date | null; taskOps: number; nudges: number; nudgesActed: number; janitorReleases: number;
}

const SUMMARY_SQL = `
SELECT s.*, a.name AS agent_name, p.key AS project_key,
  (SELECT count(*) FROM session_activity x WHERE x.session_id = s.id AND x.kind = 'task_op') AS task_ops,
  (SELECT count(*) FROM nudges n WHERE n.session_id = s.id) AS nudges,
  (SELECT count(*) FROM nudges n WHERE n.session_id = s.id AND n.acted) AS nudges_acted,
  (SELECT count(*) FROM task_events e WHERE e.actor_kind = 'system' AND e.type IN ('sent_to_review','claim_released')
     AND e.changes->'claimedBy'->>'from' = s.ref) AS janitor_releases
FROM sessions s JOIN agents a ON a.id = s.agent_id LEFT JOIN projects p ON p.id = s.project_id`;

function mapSummary(r: any): SessionSummary {
  return {
    id: r.id, ref: r.ref, agentName: r.agent_name, projectKey: r.project_key, state: r.state, branch: r.branch,
    startedAt: r.started_at, lastSeenAt: r.last_seen_at, endedAt: r.ended_at,
    taskOps: r.task_ops, nudges: r.nudges, nudgesActed: r.nudges_acted, janitorReleases: r.janitor_releases,
  };
}

export async function listSessionSummaries(q: Queryable, limit = 50): Promise<SessionSummary[]> {
  const { rows } = await q.query(`${SUMMARY_SQL} ORDER BY s.started_at DESC LIMIT $1`, [limit]);
  return rows.map(mapSummary);
}

type EventWithTask = TaskEvent & { taskRef: string; taskTitle: string };

export async function getSessionOverview(q: Queryable, sessionId: string): Promise<{
  session: SessionSummary;
  events: EventWithTask[];
  nudges: { rule: string; reason: string; acted: boolean; createdAt: Date }[];
  janitor: EventWithTask[];
} | null> {
  const { rows } = await q.query(`${SUMMARY_SQL} WHERE s.id = $1`, [sessionId]);
  if (!rows[0]) return null;
  const session = mapSummary(rows[0]);
  const withTask = async (where: string, params: unknown[]) => {
    const t = await q.query(
      `SELECT DISTINCT e.task_id, p.key, t.number, t.title FROM task_events e JOIN tasks t ON t.id = e.task_id
       JOIN projects p ON p.id = t.project_id WHERE ${where}`,
      params,
    );
    const info = new Map(t.rows.map((r) => [r.task_id as string, { taskRef: `${r.key}-${r.number}`, taskTitle: r.title as string }]));
    const events = await listTaskEvents(q, [...info.keys()]);
    return events.filter((e) => info.has(e.taskId)).map((e) => ({ ...e, ...info.get(e.taskId)! })) as EventWithTask[];
  };
  const own = (await withTask('e.session_id = $1', [sessionId])).filter((e) => e.sessionId === sessionId);
  const janitor = (await withTask(`e.actor_kind = 'system' AND e.changes->'claimedBy'->>'from' = $1`, [session.ref]))
    .filter((e) => e.actorKind === 'system' && (e.changes as any)?.claimedBy?.from === session.ref);
  const n = await q.query('SELECT rule, reason, acted, created_at FROM nudges WHERE session_id = $1 ORDER BY id', [sessionId]);
  return {
    session,
    events: own,
    nudges: n.rows.map((r) => ({ rule: r.rule, reason: r.reason, acted: r.acted, createdAt: r.created_at })),
    janitor,
  };
}
