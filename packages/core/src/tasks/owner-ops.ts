import { withTx } from '../db';
import { DomainError } from '../errors';
import { appendEvent } from '../events';
import { chatNote } from '../chat-note';
import { PRIORITIES, type Ctx, type MutationResult, type Priority, type Status, type Task } from '../types';
import { allocateTaskNumber } from '../projects';
import { formatRef } from '../refs';
import { TASK_SELECT, getTaskById, mapTask } from './queries';
import { optionalText, requireText } from './validate';
import { t as tr } from '../lang';

function assertOwner(ctx: Ctx) {
  if (ctx.actor.kind !== 'user') throw new DomainError('forbidden', 'Only the owner can do this.');
}

function assertLive(task: Task | null | undefined): Task {
  if (!task || task.deletedAt) throw new DomainError('not_found', 'Task not found.');
  return task;
}

export async function ownerSetStatus(ctx: Ctx, input: { taskId: string; status: Status; reason?: string | null }): Promise<MutationResult> {
  assertOwner(ctx);
  return withTx(ctx.db, async (tx) => {
    const task = assertLive(await getTaskById(tx, input.taskId, { forUpdate: true }));
    if (task.status === input.status) return { task, chatNote: chatNote('updated', task) };
    const reason = optionalText(input.reason, 'reason', 1000) ?? (input.status === 'dropped' ? tr('Dropped by the owner', 'Отменена владельцем') : null);
    const closed = input.status === 'done' || input.status === 'dropped';
    // Leaving in_progress releases the claim; leaving blocked clears the block (same as `start`).
    await tx.query(
      `UPDATE tasks SET status = $2::text, closed_at = CASE WHEN $3::boolean THEN now() ELSE NULL END,
         claimed_by_session_id = CASE WHEN $2::text = 'in_progress' THEN claimed_by_session_id ELSE NULL END,
         claim_expires_at = CASE WHEN $2::text = 'in_progress' THEN claim_expires_at ELSE NULL END,
         block_reason = CASE WHEN $2::text = 'blocked' THEN COALESCE($4::text, block_reason) ELSE NULL END,
         blocked_by_task_id = CASE WHEN $2::text = 'blocked' THEN blocked_by_task_id ELSE NULL END,
         version = version + 1, updated_at = now() WHERE id = $1`,
      [task.id, input.status, closed, reason],
    );
    await appendEvent(tx, { taskId: task.id, type: 'status_changed', actor: ctx.actor, reason, changes: { status: { from: task.status, to: input.status } } });
    const t = (await getTaskById(tx, task.id))!;
    return { task: t, chatNote: chatNote('updated', t) };
  });
}

export async function ownerEditTask(
  ctx: Ctx, input: { taskId: string; title?: string | null; description?: string | null; expectedVersion: number },
): Promise<MutationResult> {
  assertOwner(ctx);
  const title = input.title != null ? requireText(input.title, 'title', 200) : null;
  const description = input.description != null ? (optionalText(input.description, 'description', 10_000) ?? '') : null;
  return withTx(ctx.db, async (tx) => {
    const task = assertLive(await getTaskById(tx, input.taskId, { forUpdate: true }));
    if (task.version !== input.expectedVersion) {
      throw new DomainError('conflict_version', 'Task was changed meanwhile.', { currentVersion: task.version });
    }
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (title != null && title !== task.title) changes.title = { from: task.title, to: title };
    if (description != null && description !== task.description) changes.description = { from: task.description, to: description };
    // Re-sending the current values is not a change: no version bump, no empty `updated` event.
    if (!Object.keys(changes).length) return { task, chatNote: chatNote('updated', task) };
    await tx.query(
      `UPDATE tasks SET title = COALESCE($2, title), description = COALESCE($3, description), version = version + 1, updated_at = now() WHERE id = $1`,
      [task.id, title, description],
    );
    await appendEvent(tx, { taskId: task.id, type: 'updated', actor: ctx.actor, changes });
    const t = (await getTaskById(tx, task.id))!;
    return { task: t, chatNote: chatNote('updated', t) };
  });
}

/** A calendar date 'YYYY-MM-DD' that exists (no 2026-02-30), within a sane range. */
export function parseDueDate(v: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const d = m ? new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)) : null;
  if (!m || !d || d.toISOString().slice(0, 10) !== v || +m[1]! < 2000 || +m[1]! > 2100) {
    throw new DomainError('validation', 'due_on must be a date YYYY-MM-DD.', { field: 'due_on' });
  }
  return v;
}

/**
 * The owner sets a task's priority and/or due date (`dueOn: null` clears it). A priority the owner sets is pinned:
 * the manager will not change it later. Changes go to the history as one `updated` event.
 */
export async function ownerSetPlanning(
  ctx: Ctx, input: { taskId: string; priority?: Priority; dueOn?: string | null },
): Promise<MutationResult> {
  assertOwner(ctx);
  if (input.priority !== undefined && !(PRIORITIES as readonly string[]).includes(input.priority)) {
    throw new DomainError('validation', `priority must be one of ${PRIORITIES.join(', ')}.`, { field: 'priority' });
  }
  const dueOn = input.dueOn === undefined || input.dueOn === null ? input.dueOn : parseDueDate(input.dueOn);
  return withTx(ctx.db, async (tx) => {
    const task = assertLive(await getTaskById(tx, input.taskId, { forUpdate: true }));
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (input.priority !== undefined && input.priority !== task.priority) changes.priority = { from: task.priority, to: input.priority };
    if (dueOn !== undefined && dueOn !== task.dueOn) changes.due = { from: task.dueOn, to: dueOn };
    const pin = input.priority !== undefined && task.prioritySource !== 'owner';
    if (!Object.keys(changes).length && !pin) return { task, chatNote: chatNote('updated', task) };
    await tx.query(
      `UPDATE tasks SET priority = COALESCE($2, priority), priority_source = CASE WHEN $2::text IS NULL THEN priority_source ELSE 'owner' END,
         due_on = CASE WHEN $3::boolean THEN $4::date ELSE due_on END,
         version = version + CASE WHEN $5::boolean THEN 1 ELSE 0 END, updated_at = CASE WHEN $5::boolean THEN now() ELSE updated_at END
       WHERE id = $1`,
      [task.id, input.priority ?? null, dueOn !== undefined, dueOn ?? null, Object.keys(changes).length > 0],
    );
    // Re-choosing the current priority only pins it: no history event for a value that did not change.
    if (Object.keys(changes).length) await appendEvent(tx, { taskId: task.id, type: 'updated', actor: ctx.actor, changes });
    const t = (await getTaskById(tx, task.id))!;
    return { task: t, chatNote: chatNote('updated', t) };
  });
}

/**
 * The manager sets a priority (and optionally a due date) with its reason. A priority the owner set is never changed:
 * then nothing happens and `pinned` is true. The change goes to the history as an `updated` event by the manager.
 */
export async function managerSetPriority(
  ctx: Ctx, input: { taskId: string; priority: Priority; dueOn?: string | null; reason: string },
): Promise<{ task: Task; changed: boolean; pinned: boolean }> {
  if (ctx.actor.kind !== 'manager') throw new DomainError('forbidden', 'Only the manager can do this.');
  if (!(PRIORITIES as readonly string[]).includes(input.priority)) throw new DomainError('validation', 'Bad priority.', { field: 'priority' });
  const reason = optionalText(input.reason, 'reason', 1000);
  const dueOn = input.dueOn === undefined || input.dueOn === null ? input.dueOn : parseDueDate(input.dueOn);
  return withTx(ctx.db, async (tx) => {
    const task = assertLive(await getTaskById(tx, input.taskId, { forUpdate: true }));
    if (task.status === 'done' || task.status === 'dropped') return { task, changed: false, pinned: false };
    const pinned = task.prioritySource === 'owner';
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (!pinned && input.priority !== task.priority) changes.priority = { from: task.priority, to: input.priority };
    // the manager fills a missing date but never moves one somebody set
    if (dueOn && !task.dueOn) changes.due = { from: null, to: dueOn };
    if (!Object.keys(changes).length) return { task, changed: false, pinned };
    await tx.query(
      `UPDATE tasks SET priority = CASE WHEN $2::text IS NULL THEN priority ELSE $2::text END,
         priority_source = CASE WHEN $2::text IS NULL THEN priority_source ELSE 'manager' END,
         due_on = COALESCE(due_on, $3::date), version = version + 1, updated_at = now() WHERE id = $1`,
      [task.id, changes.priority ? input.priority : null, changes.due ? dueOn : null],
    );
    await appendEvent(tx, { taskId: task.id, type: 'updated', actor: ctx.actor, changes, reason });
    return { task: (await getTaskById(tx, task.id))!, changed: true, pinned };
  });
}

/**
 * The owner moves a task to another project (e.g. a proposal the manager filed in the wrong place). It gets the next
 * number there; the history keeps the old ref. A subtask, a parent or a task an agent is working on stays put.
 */
export async function ownerMoveTask(ctx: Ctx, input: { taskId: string; projectId: string }): Promise<MutationResult> {
  assertOwner(ctx);
  return withTx(ctx.db, async (tx) => {
    // same lock order as mergeProjects: the project rows first, then the task
    const { rows: ps } = await tx.query('SELECT id, key FROM projects WHERE id = $1 FOR UPDATE', [input.projectId]);
    if (!ps[0]) throw new DomainError('not_found', 'Project not found.');
    const task = assertLive(await getTaskById(tx, input.taskId, { forUpdate: true }));
    if (task.projectId === input.projectId) return { task, chatNote: chatNote('updated', task) };
    const { rows: kids } = await tx.query('SELECT 1 FROM tasks WHERE parent_id = $1 AND deleted_at IS NULL LIMIT 1', [task.id]);
    if (task.parentId || kids.length) throw new DomainError('validation', 'A task with a parent or subtasks cannot be moved alone.');
    if (task.claimedBySessionId) throw new DomainError('validation', `${task.ref} is being worked on; move it once the agent lets it go.`);
    const n = await allocateTaskNumber(tx, input.projectId);
    await tx.query('UPDATE tasks SET project_id = $2, number = $3, version = version + 1, updated_at = now() WHERE id = $1', [task.id, input.projectId, n]);
    const to = formatRef(ps[0].key, n);
    await appendEvent(tx, { taskId: task.id, type: 'moved', actor: ctx.actor, changes: { ref: { from: task.ref, to } } });
    const t = (await getTaskById(tx, task.id))!;
    return { task: t, chatNote: chatNote('updated', t) };
  });
}

export async function mergeDuplicate(ctx: Ctx, input: { duplicateId: string; intoId: string }): Promise<MutationResult> {
  assertOwner(ctx);
  if (input.duplicateId === input.intoId) throw new DomainError('validation', 'Cannot merge a task into itself.');
  return withTx(ctx.db, async (tx) => {
    // Both rows are locked in one statement in ascending id order, so two concurrent merges over the same pair
    // (in either direction) cannot deadlock.
    const { rows } = await tx.query(
      `${TASK_SELECT} WHERE t.id = ANY($1) ORDER BY t.id FOR UPDATE OF t`,
      [[input.duplicateId, input.intoId]],
    );
    const tasks = rows.map(mapTask);
    const dup = assertLive(tasks.find((t) => t.id === input.duplicateId));
    const into = assertLive(tasks.find((t) => t.id === input.intoId));
    await tx.query(
      `UPDATE tasks SET status = 'dropped', merged_into_task_id = $2, closed_at = now(), claimed_by_session_id = NULL,
         claim_expires_at = NULL, version = version + 1, updated_at = now() WHERE id = $1`,
      [dup.id, into.id],
    );
    await appendEvent(tx, { taskId: dup.id, type: 'merged_duplicate', actor: ctx.actor, changes: { into: { from: null, to: into.ref }, status: { from: dup.status, to: 'dropped' } } });
    await appendEvent(tx, { taskId: into.id, type: 'merged_duplicate', actor: ctx.actor, note: tr(`${dup.ref} merged into this task`, `${dup.ref} объединена сюда`) });
    const t = (await getTaskById(tx, into.id))!;
    return { task: t, chatNote: chatNote('updated', t) };
  });
}

export async function softDeleteTask(ctx: Ctx, input: { taskId: string }): Promise<void> {
  assertOwner(ctx);
  await withTx(ctx.db, async (tx) => {
    const r = await tx.query('UPDATE tasks SET deleted_at = now(), updated_at = now() WHERE id = $1 AND deleted_at IS NULL', [input.taskId]);
    if (!r.rowCount) throw new DomainError('not_found', 'Task not found.');
    await appendEvent(tx, { taskId: input.taskId, type: 'deleted', actor: ctx.actor });
  });
}
