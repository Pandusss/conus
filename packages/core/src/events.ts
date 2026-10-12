import type { Queryable } from './db';
import type { Actor, TaskEvent, TaskEventType } from './types';

export interface AppendEventInput {
  taskId: string;
  type: TaskEventType;
  actor: Actor;
  changes?: Record<string, { from: unknown; to: unknown }>;
  reason?: string | null;
  note?: string | null;
  idempotencyKey?: string | null;
}

/**
 * Appends the next event (seq = max + 1) to a task's log.
 *
 * Must be called inside a transaction (Tx): the task row lock taken here is held until commit, which is what
 * serializes concurrent appends to the same task. The lock is a separate statement on purpose: under READ COMMITTED
 * the INSERT's max(seq) subquery then runs after the lock is granted and sees the previous appender's committed row
 * (a single-statement CTE would still read a stale max). It is re-entrant when the caller already locked the row.
 */
export async function appendEvent(q: Queryable, e: AppendEventInput): Promise<void> {
  const a = e.actor;
  await q.query('SELECT 1 FROM tasks WHERE id = $1 FOR UPDATE', [e.taskId]);
  await q.query(
    `INSERT INTO task_events(task_id, seq, type, actor_kind, actor_id, session_id, model, changes, reason, note, idempotency_key)
     VALUES ($1, COALESCE((SELECT max(seq) FROM task_events WHERE task_id = $1), 0) + 1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      e.taskId, e.type, a.kind,
      a.kind === 'agent' ? a.agentId : null,
      a.kind === 'agent' ? a.sessionId : null,
      a.kind === 'agent' ? a.model : null,
      JSON.stringify(e.changes ?? {}), e.reason ?? null, e.note ?? null, e.idempotencyKey ?? null,
    ],
  );
}

export async function listTaskEvents(q: Queryable, taskIds: string[]): Promise<TaskEvent[]> {
  const { rows } = await q.query(
    `SELECT e.*, a.name AS actor_name, s.ref AS session_ref
     FROM task_events e LEFT JOIN agents a ON a.id = e.actor_id LEFT JOIN sessions s ON s.id = e.session_id
     WHERE e.task_id = ANY($1) ORDER BY e.created_at, e.id`,
    [taskIds],
  );
  return rows.map((r) => ({
    id: r.id, taskId: r.task_id, seq: r.seq, type: r.type, actorKind: r.actor_kind, actorId: r.actor_id,
    actorName: r.actor_name, sessionId: r.session_id, sessionRef: r.session_ref, model: r.model,
    changes: r.changes, reason: r.reason, note: r.note, createdAt: r.created_at,
  }));
}
