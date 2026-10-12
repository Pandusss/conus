import type { Agent, Project, Session } from './types';

export function mapProject(r: any): Project {
  return { id: r.id, key: r.key, name: r.name, repoFingerprints: r.repo_fingerprints ?? [], createdAt: r.created_at };
}
export function mapAgent(r: any): Agent {
  return {
    id: r.id, name: r.name, kind: r.kind, tokenPrefix: r.token_prefix, createdAt: r.created_at,
    revokedAt: r.revoked_at, lastSeenAt: r.last_seen_at, lastUnboundMcpAt: r.last_unbound_mcp_at,
  };
}
export function mapSession(r: any): Session {
  return {
    id: r.id, ref: r.ref, agentId: r.agent_id, agentSessionId: r.agent_session_id, projectId: r.project_id,
    cwd: r.cwd, branch: r.branch, model: r.model, currentTurn: r.current_turn, state: r.state,
    startedAt: r.started_at, lastSeenAt: r.last_seen_at, endedAt: r.ended_at, endReason: r.end_reason,
  };
}
