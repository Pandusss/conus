import { withTx, type Tx } from './db';
import { getTaskById } from './tasks/queries';
import type { CreateOutcome, Ctx, MutationResult } from './types';

// Only outcomes with a side effect are stored. A `possible_duplicates` outcome changes nothing, so it is never
// stored: a retry with the same key (typically the same call plus confirm_new) must re-run, not replay stale candidates.
type Stored =
  | { kind: 'created'; taskId: string; chatNote: string }
  | { kind: 'mutation'; taskId: string; chatNote: string };

function compact(r: Exclude<CreateOutcome, { outcome: 'possible_duplicates' }> | MutationResult): Stored {
  if ('outcome' in r) return { kind: 'created', taskId: r.task.id, chatNote: r.chatNote };
  return { kind: 'mutation', taskId: r.task.id, chatNote: r.chatNote };
}

async function replay(tx: Tx, s: Stored): Promise<CreateOutcome | MutationResult> {
  const task = await getTaskById(tx, s.taskId);
  if (!task) throw new Error('Idempotent replay: task vanished');
  return s.kind === 'created' ? { outcome: 'created', task, chatNote: s.chatNote } : { task, chatNote: s.chatNote };
}

export async function idempotent<T extends CreateOutcome | MutationResult>(
  ctx: Ctx, op: string, run: (tx: Tx) => Promise<T>,
): Promise<T> {
  const actor = ctx.actor;
  if (actor.kind !== 'agent' || !ctx.idempotencyKey) return withTx(ctx.db, run);
  const key = `${op}:${ctx.idempotencyKey}`;
  return withTx(ctx.db, async (tx) => {
    // Serialize concurrent requests carrying the same key; the loser sees the winner's row after it commits.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`idem:${actor.agentId}:${key}`]);
    const prev = await tx.query('SELECT response FROM idempotency_keys WHERE agent_id = $1 AND key = $2', [actor.agentId, key]);
    if (prev.rowCount) return (await replay(tx, prev.rows[0].response as Stored)) as T;
    const result = await run(tx);
    if ('outcome' in result && result.outcome === 'possible_duplicates') return result;
    await tx.query('INSERT INTO idempotency_keys(agent_id, key, response) VALUES ($1, $2, $3)', [
      actor.agentId, key, JSON.stringify(compact(result)),
    ]);
    return result;
  });
}
