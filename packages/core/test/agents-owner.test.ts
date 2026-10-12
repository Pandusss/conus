import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../../../test/helpers/db';
import type { Db } from '../src/db';
import { authenticateAgent, createAgent, listAgents, revokeAgent, hashToken } from '../src/agents';
import {
  createOwnerSession, deleteOwnerSession, hasOwner, setOwnerPassword, validateOwnerSession, verifyOwnerPassword,
} from '../src/owner';

let db: Db; let drop: () => Promise<void>;
beforeAll(async () => ({ db, drop } = await createTestDb()));
afterAll(async () => drop());

describe('agents', () => {
  it('issues tm_ tokens, stores only the hash, authenticates and revokes', async () => {
    const { agent, token } = await createAgent(db, { name: 'claude-code@laptop', kind: 'claude_code' });
    expect(token).toMatch(/^conus_[A-Za-z0-9_-]{43}$/);
    expect(agent.tokenPrefix).toBe(token.slice(0, 10));
    const { rows } = await db.query('SELECT token_hash FROM agents WHERE id=$1', [agent.id]);
    expect(rows[0].token_hash).toBe(hashToken(token));
    expect((await authenticateAgent(db, token))?.id).toBe(agent.id);
    expect(await authenticateAgent(db, token + 'x')).toBeNull();
    await revokeAgent(db, agent.id);
    expect(await authenticateAgent(db, token)).toBeNull();
    expect((await listAgents(db))[0]?.revokedAt).not.toBeNull();
  });
  it('rejects duplicate names with a validation error', async () => {
    await createAgent(db, { name: 'dup', kind: 'codex' });
    await expect(createAgent(db, { name: 'dup', kind: 'codex' })).rejects.toMatchObject({ code: 'validation' });
  });
});

describe('owner', () => {
  it('sets and verifies password, manages sessions', async () => {
    expect(await hasOwner(db)).toBe(false);
    await expect(setOwnerPassword(db, 'short')).rejects.toMatchObject({ code: 'validation' });
    await setOwnerPassword(db, 'correct horse battery');
    expect(await hasOwner(db)).toBe(true);
    expect(await verifyOwnerPassword(db, 'correct horse battery')).toBe(true);
    expect(await verifyOwnerPassword(db, 'wrong password')).toBe(false);
    const t = await createOwnerSession(db);
    expect(await validateOwnerSession(db, t)).toBe(true);
    await deleteOwnerSession(db, t);
    expect(await validateOwnerSession(db, t)).toBe(false);
  });
  it('invalidates existing sessions when the password changes', async () => {
    const t = await createOwnerSession(db);
    expect(await validateOwnerSession(db, t)).toBe(true);
    await setOwnerPassword(db, 'another long passphrase');
    expect(await validateOwnerSession(db, t)).toBe(false);
    expect(await verifyOwnerPassword(db, 'another long passphrase')).toBe(true);
    expect(await verifyOwnerPassword(db, 'correct horse battery')).toBe(false);
  });
});
