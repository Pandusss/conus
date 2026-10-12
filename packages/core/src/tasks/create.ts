import type { Tx } from '../db';
import { DomainError } from '../errors';
import { appendEvent } from '../events';
import { idempotent } from '../idempotency';
import { allocateTaskNumber } from '../projects';
import { chatNote } from '../chat-note';
import { CLAIM_TTL_MS, getSessionById } from '../sessions';
import type { CreateOutcome, Ctx, Status, Task, TaskType } from '../types';
import { findDuplicates } from './dedup';
import { getTaskById, getTaskByRef } from './queries';
import { optionalText, requireText } from './validate';

export interface CreateTaskInput {
  projectId: string; title: string; description?: string | null; type?: TaskType; parent?: string | null;
  startNow?: boolean; sourceQuote?: string | null; confirmNew?: { reason: string } | null;
}
export interface ProposeTaskInput {
  projectId: string; title: string; description?: string | null; sourceQuote: string; confirmNew?: { reason: string } | null;
}

export async function insertTask(tx: Tx, row: {
  projectId: string; type: TaskType; title: string; description: string; status: Status; parentId: string | null;
  sourceQuote: string | null; claimedBySessionId: string | null; claimExpiresAt: Date | null;
}): Promise<Task> {
  const number = await allocateTaskNumber(tx, row.projectId);
  const { rows } = await tx.query(
    `INSERT INTO tasks(project_id, number, type, title, description, status, parent_id, source_quote, claimed_by_session_id, claim_expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [row.projectId, number, row.type, row.title, row.description, row.status, row.parentId, row.sourceQuote, row.claimedBySessionId, row.claimExpiresAt],
  );
  return (await getTaskById(tx, rows[0].id))!;
}

async function lockProjectForCreate(tx: Tx, projectId: string) {
  // Serializes creates within a project so the dedup check sees concurrent inserts.
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['create:' + projectId]);
}

export async function createTask(ctx: Ctx, input: CreateTaskInput): Promise<CreateOutcome> {
  const title = requireText(input.title, 'title', 200);
  const description = optionalText(input.description, 'description', 10_000) ?? '';
  const sourceQuote = optionalText(input.sourceQuote, 'source_quote', 1000);
  const confirmReason = input.confirmNew ? requireText(input.confirmNew.reason, 'confirm_new.reason', 500) : null;
  return idempotent(ctx, 'create', async (tx) => {
    await lockProjectForCreate(tx, input.projectId);
    // Resolve the parent first so an invalid one is reported as such, not hidden behind possible_duplicates.
    const parent = input.parent ? await getTaskByRef(tx, input.projectId, input.parent) : null;
    if (parent && parent.projectId !== input.projectId) {
      throw new DomainError('validation', 'Parent task must be in the same project.', { parent: input.parent });
    }
    if (!confirmReason) {
      const candidates = await findDuplicates(tx, input.projectId, title);
      if (candidates.length) return { outcome: 'possible_duplicates', candidates } as CreateOutcome;
    }
    const now = ctx.now ?? new Date();
    const sessionId = ctx.actor.kind === 'agent' ? ctx.actor.sessionId : null;
    const start = !!input.startNow;
    const task = await insertTask(tx, {
      projectId: input.projectId, type: input.type ?? 'task', title, description,
      status: start ? 'in_progress' : 'todo', parentId: parent?.id ?? null, sourceQuote,
      claimedBySessionId: start ? sessionId : null,
      claimExpiresAt: start && sessionId ? new Date(now.getTime() + CLAIM_TTL_MS) : null,
    });
    await appendEvent(tx, {
      taskId: task.id, type: 'created', actor: ctx.actor, idempotencyKey: ctx.idempotencyKey,
      changes: { status: { from: null, to: task.status } },
      note: confirmReason ? `confirm_new: ${confirmReason}` : null,
    });
    if (start && sessionId) {
      // Session refs, same shape as startTask's `claimed` event (and what the janitor/overview match on).
      const sessionRef = (await getSessionById(tx, sessionId))?.ref ?? null;
      await appendEvent(tx, { taskId: task.id, type: 'claimed', actor: ctx.actor, changes: { claimedBy: { from: null, to: sessionRef } } });
    }
    return { outcome: 'created', task, chatNote: chatNote(start ? 'created_started' : 'created', task) } as CreateOutcome;
  });
}

export async function proposeTask(ctx: Ctx, input: ProposeTaskInput): Promise<CreateOutcome> {
  const title = requireText(input.title, 'title', 200);
  const description = optionalText(input.description, 'description', 10_000) ?? '';
  const sourceQuote = requireText(input.sourceQuote, 'source_quote', 1000);
  const confirmReason = input.confirmNew ? requireText(input.confirmNew.reason, 'confirm_new.reason', 500) : null;
  return idempotent(ctx, 'propose', async (tx) => {
    await lockProjectForCreate(tx, input.projectId);
    if (!confirmReason) {
      const candidates = await findDuplicates(tx, input.projectId, title);
      if (candidates.length) return { outcome: 'possible_duplicates', candidates } as CreateOutcome;
    }
    const task = await insertTask(tx, {
      projectId: input.projectId, type: 'task', title, description, status: 'proposed', parentId: null,
      sourceQuote, claimedBySessionId: null, claimExpiresAt: null,
    });
    await appendEvent(tx, {
      taskId: task.id, type: 'proposed', actor: ctx.actor, idempotencyKey: ctx.idempotencyKey,
      changes: { status: { from: null, to: 'proposed' } }, note: confirmReason ? `confirm_new: ${confirmReason}` : null,
    });
    return { outcome: 'created', task, chatNote: chatNote('proposed', task) } as CreateOutcome;
  });
}
