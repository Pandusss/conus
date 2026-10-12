import { withTx, type Db, type Tx } from './db';
import { recordFacts } from './activity';
import { endSession, touchSession } from './sessions';
import type { Fact } from './types';

/**
 * Hook ingestion with an optional idempotency key (the `conus hook` outbox retries with the same key).
 * The key row and the work share one transaction: a failure rolls the key back so the retry is applied,
 * and a key whose work committed makes later submissions no-ops. A concurrent duplicate blocks on the
 * uncommitted key row and then sees the conflict (or inserts it if the first one rolled back).
 */
async function claimKey(tx: Tx, agentId: string, key: string | null | undefined): Promise<boolean> {
  if (!key) return true;
  const ins = await tx.query(
    `INSERT INTO idempotency_keys(agent_id, key, response) VALUES ($1, $2, '{}') ON CONFLICT DO NOTHING`,
    [agentId, `hook:${key}`],
  );
  return (ins.rowCount ?? 0) > 0;
}

/** Records hook facts and touches the session; returns false when the key was already processed. */
export async function recordHookActivity(
  db: Db, input: { agentId: string; sessionId: string; idempotencyKey?: string | null; facts: Fact[] },
): Promise<boolean> {
  return withTx(db, async (tx) => {
    if (!(await claimKey(tx, input.agentId, input.idempotencyKey))) return false;
    await recordFacts(tx, input.sessionId, input.facts);
    await touchSession(tx, input.sessionId);
    return true;
  });
}

/** Ends the session; returns false when the key was already processed. */
export async function endSessionOnce(
  db: Db, input: { agentId: string; sessionId: string; idempotencyKey?: string | null; reason: string | null },
): Promise<boolean> {
  return withTx(db, async (tx) => {
    if (!(await claimKey(tx, input.agentId, input.idempotencyKey))) return false;
    await endSession(tx, input.sessionId, input.reason);
    return true;
  });
}
