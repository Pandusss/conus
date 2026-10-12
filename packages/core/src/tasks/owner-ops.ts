import { withTx } from '../db';
import { DomainError } from '../errors';
import { appendEvent } from '../events';
import { chatNote } from '../chat-note';
import type { Ctx, MutationResult, Status, Task } from '../types';
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
