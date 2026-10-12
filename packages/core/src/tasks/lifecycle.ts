import { withTx, type Tx } from '../db';
import { sameCommitSql } from '../commits';
import { DomainError } from '../errors';
import { appendEvent } from '../events';
import { idempotent } from '../idempotency';
import { chatNote } from '../chat-note';
import { CLAIM_TTL_MS } from '../sessions';
import { assertTransition } from '../state-machine';
import type { Ctx, MutationResult, Status, Task } from '../types';
import { getTaskById, getTaskByRef } from './queries';
import { optionalText, requireText } from './validate';

function sessionOf(ctx: Ctx): string | null {
  return ctx.actor.kind === 'agent' ? ctx.actor.sessionId : null;
}

async function fresh(tx: Tx, id: string): Promise<Task> {
  return (await getTaskById(tx, id))!;
}

async function claimHolder(tx: Tx, sessionId: string) {
  const { rows } = await tx.query(
    `SELECT s.ref, s.state, s.last_seen_at, a.name FROM sessions s JOIN agents a ON a.id = s.agent_id WHERE s.id = $1`,
    [sessionId],
  );
  const r = rows[0];
  return r ? { sessionRef: r.ref as string, state: r.state as string, lastSeenAt: r.last_seen_at as Date, agentName: r.name as string } : null;
}

async function sessionRefOf(tx: Tx, sessionId: string | null): Promise<string | null> {
  if (!sessionId) return null;
  const { rows } = await tx.query('SELECT ref FROM sessions WHERE id = $1', [sessionId]);
  return rows[0]?.ref ?? null;
}

export async function startTask(ctx: Ctx, input: { projectId: string; task: string }): Promise<MutationResult> {
  return idempotent(ctx, 'start', async (tx) => {
    const task = await getTaskByRef(tx, input.projectId, input.task, { forUpdate: true });
    const now = ctx.now ?? new Date();
    const sid = sessionOf(ctx);
    const expires = sid ? new Date(now.getTime() + CLAIM_TTL_MS) : null;
    if (task.status === 'in_progress') {
      // Same holder (including "nobody claims it and the actor has no session"): nothing to change.
      if (task.claimedBySessionId === sid) return { task, chatNote: chatNote('started', task) };
      if (task.claimedBySessionId && task.claimExpiresAt && task.claimExpiresAt > now) {
        const holder = await claimHolder(tx, task.claimedBySessionId);
        if (holder && holder.state === 'active') {
          const mins = Math.max(0, Math.round((now.getTime() - holder.lastSeenAt.getTime()) / 60_000));
          throw new DomainError(
            'conflict_claimed',
            `${task.ref} is already in progress in ${holder.agentName} (session ${holder.sessionRef}, active ${mins} min ago).`,
            { agentName: holder.agentName, sessionRef: holder.sessionRef, lastSeenAt: holder.lastSeenAt.toISOString() },
          );
        }
      }
      const fromRef = await sessionRefOf(tx, task.claimedBySessionId);
      await tx.query(
        'UPDATE tasks SET claimed_by_session_id = $2, claim_expires_at = $3, version = version + 1, updated_at = now() WHERE id = $1',
        [task.id, sid, expires],
      );
      await appendEvent(tx, {
        taskId: task.id, type: 'claimed', actor: ctx.actor, idempotencyKey: ctx.idempotencyKey,
        changes: { claimedBy: { from: fromRef, to: await sessionRefOf(tx, sid) } },
      });
      const t = await fresh(tx, task.id);
      return { task: t, chatNote: chatNote('started', t) };
    }
    assertTransition('start', task.status, task.ref);
    await tx.query(
      `UPDATE tasks SET status = 'in_progress', claimed_by_session_id = $2, claim_expires_at = $3,
         block_reason = NULL, blocked_by_task_id = NULL, version = version + 1, updated_at = now() WHERE id = $1`,
      [task.id, sid, expires],
    );
    await appendEvent(tx, {
      taskId: task.id, type: 'started', actor: ctx.actor, idempotencyKey: ctx.idempotencyKey,
      changes: { status: { from: task.status, to: 'in_progress' } },
    });
    const t = await fresh(tx, task.id);
    return { task: t, chatNote: chatNote('started', t) };
  });
}

export async function blockTask(
  ctx: Ctx, input: { projectId: string; task: string; reason: string; blockedBy?: string | null },
): Promise<MutationResult> {
  const reason = requireText(input.reason, 'reason', 1000);
  return idempotent(ctx, 'block', async (tx) => {
    const task = await getTaskByRef(tx, input.projectId, input.task, { forUpdate: true });
    assertTransition('block', task.status, task.ref);
    const blocker = input.blockedBy ? await getTaskByRef(tx, input.projectId, input.blockedBy) : null;
    if (blocker && blocker.id === task.id) {
      throw new DomainError('validation', `${task.ref} cannot be blocked by itself.`, { field: 'blockedBy' });
    }
    await tx.query(
      `UPDATE tasks SET status = 'blocked', block_reason = $2, blocked_by_task_id = $3, claimed_by_session_id = NULL,
         claim_expires_at = NULL, version = version + 1, updated_at = now() WHERE id = $1`,
      [task.id, reason, blocker?.id ?? null],
    );
    await appendEvent(tx, {
      taskId: task.id, type: 'blocked', actor: ctx.actor, reason, idempotencyKey: ctx.idempotencyKey,
      changes: { status: { from: task.status, to: 'blocked' }, ...(blocker ? { blockedBy: { from: null, to: blocker.ref } } : {}) },
    });
    const t = await fresh(tx, task.id);
    return { task: t, chatNote: chatNote('blocked', t) };
  });
}

/**
 * Links `sha` to the task unless the task already links that commit: a short and a full sha of one commit match by
 * prefix (sameCommitSql). Then nothing new is linked; a stored ref shorter than `sha` is upgraded to it, keeping the
 * stored subject when it has one. True only for a new link (the caller appends `commit_linked` then).
 */
async function insertCommitLink(
  tx: Tx, taskId: string, sha: string, subject: string, sessionId: string | null, amends: string | null = null, branch: string | null = null,
): Promise<boolean> {
  const same = await tx.query(
    `SELECT id, ref, meta FROM links WHERE task_id = $1 AND kind = 'commit' AND ${sameCommitSql('ref', '$2::text')}
     ORDER BY length(ref) DESC, id LIMIT 1 FOR UPDATE`,
    [taskId, sha],
  );
  const row = same.rows[0];
  if (row) {
    if (sha.length > row.ref.length) {
      const old = (row.meta ?? {}) as { subject?: string; amends?: string; branch?: string };
      const meta = { ...old, subject: old.subject || subject, ...(!old.amends && amends ? { amends } : {}), ...(!old.branch && branch ? { branch } : {}) };
      await tx.query('UPDATE links SET ref = $2, meta = $3 WHERE id = $1', [row.id, sha, JSON.stringify(meta)]);
    }
    return false;
  }
  const meta = { subject, ...(amends ? { amends } : {}), ...(branch ? { branch } : {}) };
  const r = await tx.query(
    `INSERT INTO links(task_id, kind, ref, meta, session_id) VALUES ($1, 'commit', $2, $3, $4) ON CONFLICT DO NOTHING`,
    [taskId, sha, JSON.stringify(meta), sessionId],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function completeTask(
  ctx: Ctx, input: { projectId: string; task: string; result: string; commits?: string[]; needsReview?: boolean },
): Promise<MutationResult> {
  const result = requireText(input.result, 'result', 10_000);
  return idempotent(ctx, 'complete', async (tx) => {
    const task = await getTaskByRef(tx, input.projectId, input.task, { forUpdate: true });
    assertTransition('complete', task.status, task.ref);
    const to: Status = input.needsReview ? 'review' : 'done';
    await tx.query(
      `UPDATE tasks SET status = $2::text, result = $3, closed_at = CASE WHEN $2::text = 'done' THEN now() ELSE NULL END,
         claimed_by_session_id = NULL, claim_expires_at = NULL, version = version + 1, updated_at = now() WHERE id = $1`,
      [task.id, to, result],
    );
    for (const sha of input.commits ?? []) {
      if (/^[0-9a-f]{4,40}$/i.test(sha)) await insertCommitLink(tx, task.id, sha, '', sessionOf(ctx));
    }
    await appendEvent(tx, {
      taskId: task.id, type: to === 'done' ? 'completed' : 'sent_to_review', actor: ctx.actor, note: result,
      idempotencyKey: ctx.idempotencyKey, changes: { status: { from: task.status, to } },
    });
    const t = await fresh(tx, task.id);
    return { task: t, chatNote: chatNote(to === 'done' ? 'completed' : 'review', t) };
  });
}

export async function dropTask(ctx: Ctx, input: { projectId: string; task: string; reason: string }): Promise<MutationResult> {
  const reason = requireText(input.reason, 'reason', 1000);
  return idempotent(ctx, 'drop', async (tx) => {
    const task = await getTaskByRef(tx, input.projectId, input.task, { forUpdate: true });
    assertTransition('drop', task.status, task.ref);
    await tx.query(
      `UPDATE tasks SET status = 'dropped', closed_at = now(), claimed_by_session_id = NULL, claim_expires_at = NULL,
         version = version + 1, updated_at = now() WHERE id = $1`,
      [task.id],
    );
    await appendEvent(tx, {
      taskId: task.id, type: 'dropped', actor: ctx.actor, reason, idempotencyKey: ctx.idempotencyKey,
      changes: { status: { from: task.status, to: 'dropped' } },
    });
    const t = await fresh(tx, task.id);
    return { task: t, chatNote: chatNote('dropped', t) };
  });
}

export async function updateTask(ctx: Ctx, input: {
  projectId: string; task: string; note?: string | null; title?: string | null; description?: string | null;
  expectedVersion?: number | null; promote?: boolean; reopen?: { reason: string } | null;
}): Promise<MutationResult> {
  const note = optionalText(input.note, 'note', 10_000);
  const title = input.title != null ? requireText(input.title, 'title', 200) : null;
  const description = input.description != null ? (optionalText(input.description, 'description', 10_000) ?? '') : null;
  const reopenReason = input.reopen ? requireText(input.reopen.reason, 'reopen.reason', 1000) : null;
  if (!note && title == null && description == null && !input.promote && !reopenReason) {
    throw new DomainError('validation', 'Nothing to update: pass note, title/description (with expected_version), promote or reopen.');
  }
  if ((title != null || description != null) && input.expectedVersion == null) {
    throw new DomainError('validation', 'expected_version is required to change title or description.');
  }
  return idempotent(ctx, 'update', async (tx) => {
    const task = await getTaskByRef(tx, input.projectId, input.task, { forUpdate: true });
    let kind: 'updated' | 'promoted' | 'reopened' = 'updated';
    if (title != null || description != null) {
      if (input.expectedVersion !== task.version) {
        throw new DomainError('conflict_version', `${task.ref} was changed meanwhile (version ${task.version}).`, { currentVersion: task.version });
      }
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      if (title != null && title !== task.title) changes.title = { from: task.title, to: title };
      if (description != null && description !== task.description) changes.description = { from: task.description, to: description };
      // Re-sending the current values is not a change: no version bump, no empty `updated` event.
      if (Object.keys(changes).length) {
        await tx.query(
          `UPDATE tasks SET title = COALESCE($2, title), description = COALESCE($3, description), version = version + 1, updated_at = now() WHERE id = $1`,
          [task.id, title, description],
        );
        await appendEvent(tx, { taskId: task.id, type: 'updated', actor: ctx.actor, changes, idempotencyKey: ctx.idempotencyKey });
      }
    }
    if (input.promote) {
      const cur = await fresh(tx, task.id);
      assertTransition('promote', cur.status, cur.ref);
      await tx.query(`UPDATE tasks SET status = 'todo', version = version + 1, updated_at = now() WHERE id = $1`, [task.id]);
      await appendEvent(tx, { taskId: task.id, type: 'promoted', actor: ctx.actor, changes: { status: { from: 'proposed', to: 'todo' } } });
      kind = 'promoted';
    }
    if (reopenReason) {
      const cur = await fresh(tx, task.id);
      assertTransition('reopen', cur.status, cur.ref);
      await tx.query(`UPDATE tasks SET status = 'todo', closed_at = NULL, version = version + 1, updated_at = now() WHERE id = $1`, [task.id]);
      await appendEvent(tx, { taskId: task.id, type: 'reopened', actor: ctx.actor, reason: reopenReason, changes: { status: { from: cur.status, to: 'todo' } } });
      kind = 'reopened';
    }
    if (note) {
      await tx.query('UPDATE tasks SET updated_at = now() WHERE id = $1', [task.id]);
      await appendEvent(tx, { taskId: task.id, type: 'noted', actor: ctx.actor, note });
    }
    const t = await fresh(tx, task.id);
    return { task: t, chatNote: chatNote(kind, t) };
  });
}

/**
 * Releases an abandoned in_progress task. The janitor selects candidates without a lock, so the claim
 * is re-validated here under the row lock: nothing changes (null) unless the task is still claimed by
 * `expectedSessionId` and that claim is not live again (session active with an unexpired claim, e.g.
 * the session resumed after the janitor's SELECT).
 */
export async function janitorRelease(
  ctx: Ctx, input: { taskId: string; to: 'review' | 'todo'; autoSummary?: string | null; expectedSessionId: string },
): Promise<MutationResult | null> {
  return withTx(ctx.db, async (tx) => {
    const task = await getTaskById(tx, input.taskId, { forUpdate: true });
    if (!task || task.status !== 'in_progress') return null;
    if (task.claimedBySessionId !== input.expectedSessionId) return null;
    const holder = await claimHolder(tx, input.expectedSessionId);
    const now = ctx.now ?? new Date();
    if (holder?.state === 'active' && task.claimExpiresAt !== null && task.claimExpiresAt > now) return null;
    const fromRef = await sessionRefOf(tx, task.claimedBySessionId);
    await tx.query(
      `UPDATE tasks SET status = $2::text, result = CASE WHEN $3::text IS NULL THEN result ELSE $3::text END,
         claimed_by_session_id = NULL, claim_expires_at = NULL, version = version + 1, updated_at = now() WHERE id = $1`,
      [task.id, input.to, input.to === 'review' ? (input.autoSummary ?? null) : null],
    );
    await appendEvent(tx, {
      taskId: task.id, type: input.to === 'review' ? 'sent_to_review' : 'claim_released', actor: ctx.actor,
      note: input.to === 'review' ? (input.autoSummary ?? null) : null,
      changes: { status: { from: 'in_progress', to: input.to }, claimedBy: { from: fromRef, to: null } },
    });
    const t = await fresh(tx, task.id);
    return { task: t, chatNote: chatNote(input.to === 'review' ? 'review' : 'updated', t) };
  });
}

/**
 * Janitor backstop for an in_progress task nobody claims (e.g. started by an MCP call that resolved no session):
 * back to `todo` with a system note. Re-validated under the row lock, since the janitor scans without one: nothing
 * changes (null) unless the task is still in_progress, still unclaimed and has no event since `idleSince`.
 */
export async function releaseUnownedTask(
  ctx: Ctx, input: { taskId: string; idleSince: Date; note: string },
): Promise<MutationResult | null> {
  return withTx(ctx.db, async (tx) => {
    const task = await getTaskById(tx, input.taskId, { forUpdate: true });
    if (!task || task.deletedAt || task.status !== 'in_progress' || task.claimedBySessionId !== null) return null;
    const recent = await tx.query('SELECT 1 FROM task_events WHERE task_id = $1 AND created_at >= $2 LIMIT 1', [task.id, input.idleSince]);
    if (recent.rows.length) return null;
    await tx.query(
      `UPDATE tasks SET status = 'todo', claim_expires_at = NULL, version = version + 1, updated_at = now() WHERE id = $1`,
      [task.id],
    );
    // No claimedBy change: there was no claim. health.ts attributes this release to the agent that started the task.
    await appendEvent(tx, {
      taskId: task.id, type: 'claim_released', actor: ctx.actor, note: input.note,
      changes: { status: { from: 'in_progress', to: 'todo' } },
    });
    const t = await fresh(tx, task.id);
    return { task: t, chatNote: chatNote('updated', t) };
  });
}

/**
 * Links a commit to a task, at most once: a short and a full sha of one commit are one link (see insertCommitLink).
 * `amends` (the HEAD the commit replaced, e.g. `git commit --amend`) removes that commit's link first — matched by
 * sha prefix, so a 4–6-char ref from task_complete goes too — so the task does not keep a sha that is no longer in
 * history. The old `commit_linked` event stays in the task history.
 */
export async function linkCommit(
  ctx: Ctx, input: { taskId: string; sha: string; subject: string; amends?: string | null; branch?: string | null },
): Promise<boolean> {
  return withTx(ctx.db, async (tx) => {
    if (!(await getTaskById(tx, input.taskId, { forUpdate: true }))) throw new DomainError('not_found', 'Task not found.');
    const amends = input.amends?.toLowerCase();
    if (amends && amends !== input.sha.toLowerCase()) {
      await tx.query(
        `DELETE FROM links WHERE task_id = $1 AND kind = 'commit' AND ${sameCommitSql('ref', '$2::text')}`,
        [input.taskId, amends],
      );
    }
    const inserted = await insertCommitLink(tx, input.taskId, input.sha, input.subject, sessionOf(ctx), amends ?? null, input.branch ?? null);
    if (inserted) {
      await appendEvent(tx, { taskId: input.taskId, type: 'commit_linked', actor: ctx.actor, note: `${input.sha.slice(0, 7)} ${input.subject}`.trim() });
    }
    return inserted;
  });
}
