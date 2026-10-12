import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../../../test/helpers/db';
import { seedAgentSession } from '../../../test/helpers/fixtures';
import type { Db } from '../src/db';
import { endSessionOnce, recordHookActivity } from '../src/hooks-ingest';
import { getSessionById, startSession } from '../src/sessions';
import type { Fact } from '../src/types';

let db: Db; let drop: () => Promise<void>;
beforeAll(async () => ({ db, drop } = await createTestDb()));
afterAll(async () => drop());

const edit = (path: string): Fact => ({ kind: 'file_edit', data: { path } });
const edits = async (sessionId: string) =>
  (await db.query(`SELECT data->>'path' AS p FROM session_activity WHERE session_id = $1 AND kind = 'file_edit' ORDER BY id`, [sessionId]))
    .rows.map((r) => r.p as string);
const keyRows = async (agentId: string, key: string) =>
  (await db.query('SELECT 1 FROM idempotency_keys WHERE agent_id = $1 AND key = $2', [agentId, `hook:${key}`])).rowCount;

describe('recordHookActivity', () => {
  it('a repeated key after success returns false and stores the facts once', async () => {
    const { agent, session } = await seedAgentSession(db);
    const input = { agentId: agent.id, sessionId: session.id, idempotencyKey: 'k1', facts: [edit('a.ts'), edit('b.ts')] };
    expect(await recordHookActivity(db, input)).toBe(true);
    expect(await recordHookActivity(db, input)).toBe(false);
    expect(await edits(session.id)).toEqual(['a.ts', 'b.ts']);
  });

  it('without a key every call is applied', async () => {
    const { agent, session } = await seedAgentSession(db);
    const input = { agentId: agent.id, sessionId: session.id, idempotencyKey: null, facts: [edit('a.ts')] };
    expect(await recordHookActivity(db, input)).toBe(true);
    expect(await recordHookActivity(db, input)).toBe(true);
    expect(await edits(session.id)).toEqual(['a.ts', 'a.ts']);
  });

  it('a failing batch rolls back the key and every fact, so a retry with the same key is applied', async () => {
    const { agent, session } = await seedAgentSession(db);
    // A NUL character passes request validation but jsonb rejects it: the second insert fails.
    const bad = { agentId: agent.id, sessionId: session.id, idempotencyKey: 'k-retry', facts: [edit('a.ts'), edit('b\u0000.ts')] };
    await expect(recordHookActivity(db, bad)).rejects.toThrow();
    expect(await keyRows(agent.id, 'k-retry')).toBe(0);
    expect(await edits(session.id)).toEqual([]);

    const retry = { ...bad, facts: [edit('a.ts'), edit('b.ts')] };
    expect(await recordHookActivity(db, retry)).toBe(true);
    expect(await edits(session.id)).toEqual(['a.ts', 'b.ts']);
    expect(await keyRows(agent.id, 'k-retry')).toBe(1);
  });

  it('the same key submitted concurrently is applied exactly once', async () => {
    const { agent, session } = await seedAgentSession(db);
    const input = { agentId: agent.id, sessionId: session.id, idempotencyKey: 'k-race', facts: [edit('x.ts')] };
    const results = await Promise.all([recordHookActivity(db, input), recordHookActivity(db, input), recordHookActivity(db, input)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await edits(session.id)).toEqual(['x.ts']);
  });

  it('keys are scoped per agent', async () => {
    const a = await seedAgentSession(db);
    const b = await seedAgentSession(db);
    expect(await recordHookActivity(db, { agentId: a.agent.id, sessionId: a.session.id, idempotencyKey: 'shared', facts: [edit('a.ts')] })).toBe(true);
    expect(await recordHookActivity(db, { agentId: b.agent.id, sessionId: b.session.id, idempotencyKey: 'shared', facts: [edit('b.ts')] })).toBe(true);
  });
});

describe('endSessionOnce', () => {
  it('a repeated key after success returns false and does not end the session again', async () => {
    const { agent, session } = await seedAgentSession(db, { agentSessionId: 'end-once' });
    expect(await endSessionOnce(db, { agentId: agent.id, sessionId: session.id, idempotencyKey: 'e1', reason: 'exit' })).toBe(true);
    expect((await getSessionById(db, session.id))!.state).toBe('ended');

    // The session is resumed; a late duplicate of the old end request must not end it.
    await startSession(db, {
      agentId: agent.id, agentSessionId: 'end-once', source: 'resume', cwd: '/repo',
      repo: { remote: 'git@github.com:me/wb.git', rootName: 'wb', rootPathHash: 'h' },
    });
    expect(await endSessionOnce(db, { agentId: agent.id, sessionId: session.id, idempotencyKey: 'e1', reason: 'exit' })).toBe(false);
    expect((await getSessionById(db, session.id))!.state).toBe('active');
  });

  it('a failing end rolls back the key, so a retry with the same key is applied', async () => {
    const { agent, session } = await seedAgentSession(db);
    // Postgres text rejects NUL, so the UPDATE fails after the key insert.
    await expect(endSessionOnce(db, { agentId: agent.id, sessionId: session.id, idempotencyKey: 'e-retry', reason: 'bad\u0000' })).rejects.toThrow();
    expect(await keyRows(agent.id, 'e-retry')).toBe(0);
    expect((await getSessionById(db, session.id))!.state).toBe('active');

    expect(await endSessionOnce(db, { agentId: agent.id, sessionId: session.id, idempotencyKey: 'e-retry', reason: 'exit' })).toBe(true);
    const s = (await getSessionById(db, session.id))!;
    expect([s.state, s.endReason]).toEqual(['ended', 'exit']);
  });

  it('without a key the session is ended', async () => {
    const { agent, session } = await seedAgentSession(db);
    expect(await endSessionOnce(db, { agentId: agent.id, sessionId: session.id, reason: null })).toBe(true);
    expect((await getSessionById(db, session.id))!.state).toBe('ended');
  });
});
