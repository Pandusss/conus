import { createHash, randomBytes } from 'node:crypto';
import { isUniqueViolation, type Db, type Queryable } from './db';
import { DomainError } from './errors';
import { mapAgent } from './rows';
import type { Agent, AgentKind } from './types';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createAgent(db: Db, input: { name: string; kind: AgentKind }): Promise<{ agent: Agent; token: string }> {
  const name = input.name.trim();
  if (!name || name.length > 100) throw new DomainError('validation', 'Agent name must be 1..100 characters.');
  const token = 'conus_' + randomBytes(32).toString('base64url');
  try {
    const { rows } = await db.query(
      'INSERT INTO agents(name, kind, token_hash, token_prefix) VALUES ($1,$2,$3,$4) RETURNING *',
      [name, input.kind, hashToken(token), token.slice(0, 10)],
    );
    return { agent: mapAgent(rows[0]), token };
  } catch (e) {
    if (isUniqueViolation(e)) throw new DomainError('validation', `Agent "${name}" already exists.`);
    throw e;
  }
}

export async function authenticateAgent(db: Db, token: string): Promise<Agent | null> {
  if (!token?.startsWith('conus_')) return null;
  const { rows } = await db.query('SELECT * FROM agents WHERE token_hash = $1 AND revoked_at IS NULL', [hashToken(token)]);
  if (!rows[0]) return null;
  const agent = mapAgent(rows[0]);
  if (!agent.lastSeenAt || Date.now() - agent.lastSeenAt.getTime() > 60_000) {
    await db.query('UPDATE agents SET last_seen_at = now() WHERE id = $1', [agent.id]);
  }
  return agent;
}

export async function listAgents(q: Queryable): Promise<Agent[]> {
  const { rows } = await q.query('SELECT * FROM agents ORDER BY created_at');
  return rows.map(mapAgent);
}

export async function getAgent(q: Queryable, id: string): Promise<Agent | null> {
  const { rows } = await q.query('SELECT * FROM agents WHERE id = $1', [id]);
  return rows[0] ? mapAgent(rows[0]) : null;
}

export async function revokeAgent(q: Queryable, id: string): Promise<void> {
  const r = await q.query('UPDATE agents SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id]);
  if (!r.rowCount) throw new DomainError('not_found', 'Agent not found or already revoked.');
}

export async function markUnboundMcp(q: Queryable, agentId: string): Promise<void> {
  await q.query('UPDATE agents SET last_unbound_mcp_at = now() WHERE id = $1', [agentId]);
}
