import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createAgent, createDb, createJudgeFromEnv, type Db, type Queryable } from '@conus/core';
import { startServer } from '@conus/server/src/server';
import { toOpCounts, type EvalState, type EvalTask } from './score';

export interface Harness { url: string; token: string; db: Db; judgeEnabled: boolean; stop(): Promise<void> }

/**
 * Evals create projects, tasks and agents and score by project, so they must not run against a database that is
 * already in use (e.g. a real conus instance). An empty database, or one without the schema yet, is fine.
 */
export async function assertEvalDbClean(q: Queryable, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (env.EVAL_ALLOW_DIRTY_DB === '1') return;
  const { rows } = await q.query(`SELECT to_regclass('public.projects') IS NOT NULL AS has`);
  if (!rows[0].has) return;
  const { rows: c } = await q.query(`SELECT count(*)::int AS n FROM projects`);
  if (c[0].n > 0) {
    throw new Error(`EVAL_DATABASE_URL points at a database that already has ${c[0].n} project(s). Use an empty database, or set EVAL_ALLOW_DIRTY_DB=1 to run anyway.`);
  }
}

export async function startHarness(): Promise<Harness> {
  let container: StartedPostgreSqlContainer | undefined;
  let url = process.env.EVAL_DATABASE_URL;
  if (url) {
    const probe = createDb(url, 1);
    try { await assertEvalDbClean(probe); } finally { await probe.end(); }
  } else {
    // Debian image on purpose: its en_US.utf8 ctype lets pg_trgm index Cyrillic titles.
    container = await new PostgreSqlContainer('postgres:16').start();
    url = container.getConnectionUri();
  }
  try {
    const judge = createJudgeFromEnv();
    const srv = await startServer({ databaseUrl: url, port: 0, host: '127.0.0.1', publicUrl: 'http://127.0.0.1', uiDir: null, cookieSecure: false, janitorIntervalMs: 3_600_000, judge, lang: 'en' });
    const { token } = await createAgent(srv.db, { name: `eval-${Date.now()}`, kind: 'claude_code' });
    return { url: srv.url, token, db: srv.db, judgeEnabled: judge.enabled, async stop() { await srv.close(); await container?.stop(); } };
  } catch (e) {
    await container?.stop();
    throw e;
  }
}

export async function collectState(h: Harness, projectId: string, seededIds: string[]): Promise<EvalState> {
  const { rows } = await h.db.query(
    `SELECT t.id, t.number, p.key, t.title, t.status, t.type, t.result, t.source_quote, pt.number AS parent_number,
       (SELECT count(*)::int FROM links l WHERE l.task_id = t.id AND l.kind = 'commit') AS commits,
       EXISTS (SELECT 1 FROM task_events e WHERE e.task_id = t.id AND e.actor_kind = 'agent') AS touched
     FROM tasks t JOIN projects p ON p.id = t.project_id LEFT JOIN tasks pt ON pt.id = t.parent_id
     WHERE t.project_id = $1 AND t.deleted_at IS NULL ORDER BY t.number`,
    [projectId],
  );
  const tasks: EvalTask[] = rows.map((r) => ({
    ref: `${r.key}-${r.number}`, title: r.title, status: r.status, type: r.type, result: r.result, sourceQuote: r.source_quote,
    parentRef: r.parent_number ? `${r.key}-${r.parent_number}` : null, commits: r.commits,
    seededIndex: seededIds.indexOf(r.id) >= 0 ? seededIds.indexOf(r.id) : null, createdInRun: !seededIds.includes(r.id),
    touchedInRun: r.touched,
  }));
  const n = await h.db.query(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE acted)::int AS acted FROM nudges WHERE session_id IN (SELECT id FROM sessions WHERE project_id = $1)`,
    [projectId],
  );
  const j = await h.db.query(
    `SELECT count(*)::int AS n FROM task_events e JOIN tasks t ON t.id = e.task_id
     WHERE t.project_id = $1 AND e.actor_kind = 'system' AND e.type IN ('sent_to_review','claim_released')`,
    [projectId],
  );
  // A subtask titled like its parent is decomposition, not duplication.
  const d = await h.db.query(
    `SELECT count(*)::int AS n FROM tasks a JOIN tasks b ON a.project_id = b.project_id AND a.number < b.number
     WHERE a.project_id = $1 AND a.status <> 'dropped' AND b.status <> 'dropped' AND a.deleted_at IS NULL AND b.deleted_at IS NULL
       AND b.parent_id IS DISTINCT FROM a.id AND a.parent_id IS DISTINCT FROM b.id
       AND similarity(lower(a.title), lower(b.title)) >= 0.6`,
    [projectId],
  );
  // A create with start_now is also a start (its only event is `created` → in_progress).
  const ops = await h.db.query(
    `SELECT e.type, count(*)::int AS n FROM task_events e JOIN tasks t ON t.id = e.task_id
     WHERE t.project_id = $1 AND e.actor_kind = 'agent' GROUP BY e.type
     UNION ALL
     SELECT 'started', count(*)::int FROM task_events e JOIN tasks t ON t.id = e.task_id
     WHERE t.project_id = $1 AND e.actor_kind = 'agent' AND e.type = 'created' AND e.changes->'status'->>'to' = 'in_progress'`,
    [projectId],
  );
  return {
    tasks, nudges: n.rows[0].n, nudgesActed: n.rows[0].acted, janitorReleases: j.rows[0].n, duplicatePairs: d.rows[0].n,
    ops: toOpCounts(ops.rows),
  };
}

/** Hook sessions the server registered for the project — 0 means the agent's hooks never reached the harness. */
export async function countSessions(h: Harness, projectId: string): Promise<number> {
  const { rows } = await h.db.query(`SELECT count(*)::int AS n FROM sessions WHERE project_id = $1`, [projectId]);
  return rows[0].n;
}
