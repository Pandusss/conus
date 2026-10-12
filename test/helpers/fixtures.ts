import { createAgent } from '../../packages/core/src/agents';
import { startSession } from '../../packages/core/src/sessions';
import type { Db } from '../../packages/core/src/db';
import type { Actor, Agent, Project, Session } from '../../packages/core/src/types';

let counter = 0;

export async function seedAgentSession(
  db: Db,
  opts: { agentName?: string; remote?: string; agentSessionId?: string } = {},
): Promise<{ agent: Agent; token: string; session: Session; project: Project; actor: Actor }> {
  counter++;
  const { agent, token } = await createAgent(db, { name: opts.agentName ?? `agent-${counter}-${Date.now()}`, kind: 'claude_code' });
  const remote = opts.remote ?? 'git@github.com:me/wb.git';
  const { session, project } = await startSession(db, {
    agentId: agent.id,
    agentSessionId: opts.agentSessionId ?? `ext-${counter}`,
    source: 'startup',
    cwd: '/repo',
    repo: { remote, rootName: 'wb', rootPathHash: 'hash' + counter, branch: 'main' },
    model: 'test-model',
  });
  return { agent, token, session, project, actor: { kind: 'agent', agentId: agent.id, sessionId: session.id, model: 'test-model' } };
}

export async function seedSecondSession(db: Db, agentId: string, projectRemote: string, agentSessionId: string) {
  const { session } = await startSession(db, {
    agentId, agentSessionId, source: 'startup', cwd: '/repo',
    repo: { remote: projectRemote, rootName: 'wb', rootPathHash: 'x', branch: 'main' },
  });
  const actor: Actor = { kind: 'agent', agentId, sessionId: session.id, model: null };
  return { session, actor };
}
