import type { Queryable } from '../db';
import { DomainError } from '../errors';
import { formatRef, parseTaskRef } from '../refs';
import { listTaskEvents } from '../events';
import { STATUSES, type Link, type Status, type Task, type TaskEvent, type TaskView } from '../types';

export const TASK_SELECT = `
SELECT t.*, p.key AS project_key,
  pt.number AS parent_number, pp.key AS parent_key,
  bt.number AS blocked_by_number, bp.key AS blocked_by_key
FROM tasks t
JOIN projects p ON p.id = t.project_id
LEFT JOIN tasks pt ON pt.id = t.parent_id
LEFT JOIN projects pp ON pp.id = pt.project_id
LEFT JOIN tasks bt ON bt.id = t.blocked_by_task_id
LEFT JOIN projects bp ON bp.id = bt.project_id`;

export function mapTask(r: any): Task {
  return {
    id: r.id, projectId: r.project_id, projectKey: r.project_key, number: r.number,
    ref: formatRef(r.project_key, r.number),
    parentId: r.parent_id,
    parentRef: r.parent_number != null ? formatRef(r.parent_key, r.parent_number) : null,
    type: r.type, title: r.title, description: r.description, status: r.status,
    result: r.result, blockReason: r.block_reason,
    blockedByRef: r.blocked_by_number != null ? formatRef(r.blocked_by_key, r.blocked_by_number) : null,
    sourceQuote: r.source_quote, claimedBySessionId: r.claimed_by_session_id, claimExpiresAt: r.claim_expires_at,
    mergedIntoId: r.merged_into_task_id, version: r.version,
    createdAt: r.created_at, updatedAt: r.updated_at, closedAt: r.closed_at, deletedAt: r.deleted_at,
  };
}

/**
 * TASK_SELECT plus what the owner's board shows on a card: the project name, the claim holder (session ref and agent name)
 * and the number of live subtasks and linked commits. The counts come from one grouped pass over each table, which stays
 * cheap for a board-sized list (no per-row subquery over the unindexed parent_id).
 */
export const TASK_VIEW_SELECT = `
SELECT t.*, p.key AS project_key, p.name AS project_name,
  pt.number AS parent_number, pp.key AS parent_key,
  bt.number AS blocked_by_number, bp.key AS blocked_by_key,
  hs.ref AS holder_session_ref, ha.name AS holder_agent_name,
  COALESCE(sc.n, 0) AS subtask_count, COALESCE(lc.n, 0) AS commit_count
FROM tasks t
JOIN projects p ON p.id = t.project_id
LEFT JOIN tasks pt ON pt.id = t.parent_id
LEFT JOIN projects pp ON pp.id = pt.project_id
LEFT JOIN tasks bt ON bt.id = t.blocked_by_task_id
LEFT JOIN projects bp ON bp.id = bt.project_id
LEFT JOIN sessions hs ON hs.id = t.claimed_by_session_id
LEFT JOIN agents ha ON ha.id = hs.agent_id
LEFT JOIN (SELECT parent_id, count(*)::int AS n FROM tasks WHERE parent_id IS NOT NULL AND deleted_at IS NULL GROUP BY parent_id) sc
  ON sc.parent_id = t.id
LEFT JOIN (SELECT task_id, count(*)::int AS n FROM links WHERE kind = 'commit' GROUP BY task_id) lc ON lc.task_id = t.id`;

export function mapTaskView(r: any): TaskView {
  return {
    ...mapTask(r),
    projectName: r.project_name,
    holder: r.claimed_by_session_id && r.holder_session_ref
      ? { agentName: r.holder_agent_name, sessionRef: r.holder_session_ref, sessionId: r.claimed_by_session_id }
      : null,
    subtaskCount: r.subtask_count,
    commitCount: r.commit_count,
  };
}

export async function getTaskById(q: Queryable, id: string, opts: { forUpdate?: boolean } = {}): Promise<Task | null> {
  const { rows } = await q.query(`${TASK_SELECT} WHERE t.id = $1 ${opts.forUpdate ? 'FOR UPDATE OF t' : ''}`, [id]);
  return rows[0] ? mapTask(rows[0]) : null;
}

export async function getTaskByRef(q: Queryable, projectId: string, ref: string, opts: { forUpdate?: boolean } = {}): Promise<Task> {
  const { key, number } = parseTaskRef(ref);
  const lock = opts.forUpdate ? 'FOR UPDATE OF t' : '';
  const { rows } = key
    ? await q.query(`${TASK_SELECT} WHERE p.key = $1 AND t.number = $2 AND t.deleted_at IS NULL ${lock}`, [key, number])
    : await q.query(`${TASK_SELECT} WHERE t.project_id = $1 AND t.number = $2 AND t.deleted_at IS NULL ${lock}`, [projectId, number]);
  if (!rows[0]) throw new DomainError('not_found', `Task ${ref} not found.`, { ref });
  return mapTask(rows[0]);
}

export async function listTasks(
  q: Queryable,
  f: { projectId?: string; statuses?: readonly Status[]; query?: string | null; limit?: number },
): Promise<TaskView[]> {
  const where: string[] = ['t.deleted_at IS NULL'];
  const params: unknown[] = [];
  if (f.projectId) { params.push(f.projectId); where.push(`t.project_id = $${params.length}`); }
  if (f.statuses?.length) { params.push(f.statuses); where.push(`t.status = ANY($${params.length})`); }
  let order = 't.updated_at DESC';
  if (f.query && f.query.trim()) {
    params.push(f.query.trim().toLowerCase());
    const p = `$${params.length}`;
    where.push(`(lower(t.title || ' ' || t.description) LIKE '%' || ${p} || '%' OR word_similarity(${p}, lower(t.title || ' ' || t.description)) >= 0.4)`);
    order = `word_similarity(${p}, lower(t.title || ' ' || t.description)) DESC, t.updated_at DESC`;
  }
  params.push(f.limit ?? 100);
  const { rows } = await q.query(`${TASK_VIEW_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT $${params.length}`, params);
  return rows.map(mapTaskView);
}

export async function listClaimedTasks(q: Queryable, sessionId: string): Promise<Task[]> {
  const { rows } = await q.query(
    `${TASK_SELECT} WHERE t.claimed_by_session_id = $1 AND t.status = 'in_progress' AND t.deleted_at IS NULL ORDER BY t.updated_at DESC`,
    [sessionId],
  );
  return rows.map(mapTask);
}

export async function listSessionTasks(q: Queryable, sessionId: string, limit = 20): Promise<Task[]> {
  const { rows } = await q.query(
    `${TASK_SELECT} WHERE t.deleted_at IS NULL AND t.id IN (SELECT DISTINCT task_id FROM task_events WHERE session_id = $1)
     ORDER BY t.updated_at DESC LIMIT $2`,
    [sessionId, limit],
  );
  return rows.map(mapTask);
}

export async function getTaskDetail(
  q: Queryable, id: string,
): Promise<{ task: TaskView; events: TaskEvent[]; links: Link[]; subtasks: TaskView[] } | null> {
  const { rows } = await q.query(`${TASK_VIEW_SELECT} WHERE t.id = $1`, [id]);
  if (!rows[0]) return null;
  const task = mapTaskView(rows[0]);
  const merged = await q.query('SELECT id FROM tasks WHERE merged_into_task_id = $1', [id]);
  const events = await listTaskEvents(q, [id, ...merged.rows.map((r) => r.id as string)]);
  const linkRows = await q.query('SELECT * FROM links WHERE task_id = $1 ORDER BY created_at', [id]);
  const links: Link[] = linkRows.rows.map((r) => ({
    id: r.id, taskId: r.task_id, kind: r.kind, ref: r.ref, meta: r.meta, sessionId: r.session_id, createdAt: r.created_at,
  }));
  const sub = await q.query(`${TASK_VIEW_SELECT} WHERE t.parent_id = $1 AND t.deleted_at IS NULL ORDER BY t.number`, [id]);
  return { task, events, links, subtasks: sub.rows.map(mapTaskView) };
}

export async function countProposals(q: Queryable, projectId: string): Promise<number> {
  const { rows } = await q.query(
    `SELECT count(*)::int AS n FROM tasks WHERE project_id = $1 AND status = 'proposed' AND deleted_at IS NULL`,
    [projectId],
  );
  return rows[0].n;
}

export async function countByStatus(q: Queryable, projectId: string): Promise<Record<Status, number>> {
  const { rows } = await q.query(
    'SELECT status, count(*) AS n FROM tasks WHERE project_id = $1 AND deleted_at IS NULL GROUP BY status',
    [projectId],
  );
  const out = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  for (const r of rows) out[r.status as Status] = r.n;
  return out;
}
