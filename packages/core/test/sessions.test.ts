import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../../../test/helpers/db';
import type { Db } from '../src/db';
import { createAgent } from '../src/agents';
import {
  beginTurn, endSession, getSessionByAgentSessionId, getSessionById, resolveSessionForMcp, setSessionModel, startSession, touchSession,
} from '../src/sessions';

let db: Db; let drop: () => Promise<void>;
beforeAll(async () => ({ db, drop } = await createTestDb()));
afterAll(async () => drop());

const repo = { remote: 'git@github.com:me/wb.git', rootName: 'wb', rootPathHash: 'h1', branch: 'main' };

describe('sessions', () => {
  it('starts, resumes the same row, and binds the project', async () => {
    const { agent } = await createAgent(db, { name: 'a1', kind: 'claude_code' });
    const s1 = await startSession(db, { agentId: agent.id, agentSessionId: 'ext-1', source: 'startup', cwd: '/w', repo, model: 'm' });
    expect(s1.session.ref).toMatch(/^S-[0-9a-f]{4,6}$/);
    expect(s1.project.key).toBe('WB');
    await endSession(db, s1.session.id, 'exit');
    const s2 = await startSession(db, { agentId: agent.id, agentSessionId: 'ext-1', source: 'resume', cwd: '/w', repo });
    expect(s2.session.id).toBe(s1.session.id);
    expect(s2.session.state).toBe('active');
    expect(s2.session.endedAt).toBeNull();
  });

  it('setSessionModel stores the model reported later (Claude SessionStart carries none) and says whether it changed', async () => {
    const { agent } = await createAgent(db, { name: 'a-model', kind: 'claude_code' });
    const { session } = await startSession(db, { agentId: agent.id, agentSessionId: 'ext-model', source: 'startup', cwd: '/w', repo });
    expect(session.model).toBeNull();
    expect(await setSessionModel(db, session.id, 'claude-opus-5')).toBe(true);
    expect((await getSessionById(db, session.id))?.model).toBe('claude-opus-5');
    expect(await setSessionModel(db, session.id, 'claude-opus-5')).toBe(false);
    expect(await setSessionModel(db, session.id, 'claude-sonnet-5')).toBe(true);
    expect((await getSessionById(db, session.id))?.model).toBe('claude-sonnet-5');
  });

  it('counts turns and ends', async () => {
    const { agent } = await createAgent(db, { name: 'a2', kind: 'codex' });
    const { session } = await startSession(db, { agentId: agent.id, agentSessionId: 'ext-2', source: 'startup', cwd: '/w', repo });
    expect(await beginTurn(db, session.id)).toBe(1);
    expect(await beginTurn(db, session.id)).toBe(2);
    await endSession(db, session.id, 'logout');
    const s = await getSessionByAgentSessionId(db, agent.id, 'ext-2');
    expect(s?.state).toBe('ended');
    expect(s?.endReason).toBe('logout');
  });

  it('touch extends claims of the session', async () => {
    const { agent } = await createAgent(db, { name: 'a3', kind: 'codex' });
    const { session, project } = await startSession(db, { agentId: agent.id, agentSessionId: 'ext-3', source: 'startup', cwd: '/w', repo });
    await db.query(
      `INSERT INTO tasks(project_id, number, type, title, status, claimed_by_session_id, claim_expires_at)
       VALUES ($1, 999, 'task', 't', 'in_progress', $2, now() - interval '1 minute')`,
      [project.id, session.id],
    );
    await touchSession(db, session.id);
    const { rows } = await db.query('SELECT claim_expires_at > now() + interval \'29 minutes\' AS ok FROM tasks WHERE number = 999');
    expect(rows[0].ok).toBe(true);
  });

  it('resolves MCP calls: explicit ref, bound mcp id, single active session, ambiguity', async () => {
    const { agent } = await createAgent(db, { name: 'a4', kind: 'claude_code' });
    const { session: s1 } = await startSession(db, { agentId: agent.id, agentSessionId: 'e1', source: 'startup', cwd: '/w', repo });
    // single active session → bound
    expect((await resolveSessionForMcp(db, { agentId: agent.id, mcpSessionId: 'm-1' }))?.id).toBe(s1.id);
    // now bound by mcp id even after a second session appears
    const { session: s2 } = await startSession(db, { agentId: agent.id, agentSessionId: 'e2', source: 'startup', cwd: '/w', repo });
    expect((await resolveSessionForMcp(db, { agentId: agent.id, mcpSessionId: 'm-1' }))?.id).toBe(s1.id);
    // ambiguous: two active sessions, unknown mcp id, no ref
    expect(await resolveSessionForMcp(db, { agentId: agent.id, mcpSessionId: 'm-2' })).toBeNull();
    // explicit ref wins and binds
    expect((await resolveSessionForMcp(db, { agentId: agent.id, sessionRef: s2.ref, mcpSessionId: 'm-2' }))?.id).toBe(s2.id);
    expect((await resolveSessionForMcp(db, { agentId: agent.id, mcpSessionId: 'm-2' }))?.id).toBe(s2.id);
    // a ref of another agent's session is ignored
    const { agent: other } = await createAgent(db, { name: 'a5', kind: 'codex' });
    expect(await resolveSessionForMcp(db, { agentId: other.id, sessionRef: s2.ref })).toBeNull();
  });

  it('does not resolve an mcp id to an ended session; falls through to the single active one and rebinds', async () => {
    const { agent } = await createAgent(db, { name: 'a6', kind: 'claude_code' });
    const { session: a } = await startSession(db, { agentId: agent.id, agentSessionId: 'x1', source: 'startup', cwd: '/w', repo });
    expect((await resolveSessionForMcp(db, { agentId: agent.id, mcpSessionId: 'm-x' }))?.id).toBe(a.id);
    await endSession(db, a.id, 'clear');
    const { session: b } = await startSession(db, { agentId: agent.id, agentSessionId: 'x2', source: 'clear', cwd: '/w', repo });
    expect((await resolveSessionForMcp(db, { agentId: agent.id, mcpSessionId: 'm-x' }))?.id).toBe(b.id);
    const { rows } = await db.query('SELECT id, mcp_session_ids FROM sessions WHERE id = ANY($1)', [[a.id, b.id]]);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.mcp_session_ids as string[]]));
    expect(byId[b.id]).toContain('m-x');
    expect(byId[a.id]).not.toContain('m-x');
  });

  it('rule 1 skips an ended session: its ref neither resolves nor steals the mcp binding', async () => {
    const { agent } = await createAgent(db, { name: 'a8', kind: 'claude_code' });
    const { session: old } = await startSession(db, { agentId: agent.id, agentSessionId: 'z1', source: 'startup', cwd: '/w', repo });
    await endSession(db, old.id, 'exit');
    const { session: live } = await startSession(db, { agentId: agent.id, agentSessionId: 'z2', source: 'startup', cwd: '/w', repo });
    // the ended ref falls through to rule 3 (the single active session) and binds there
    expect((await resolveSessionForMcp(db, { agentId: agent.id, sessionRef: old.ref, mcpSessionId: 'm-z' }))?.id).toBe(live.id);
    const { rows } = await db.query('SELECT id, mcp_session_ids FROM sessions WHERE id = ANY($1)', [[old.id, live.id]]);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.mcp_session_ids as string[]]));
    expect(byId[old.id]).not.toContain('m-z');
    expect(byId[live.id]).toContain('m-z');
    // with no other session to fall back to there is no binding at all
    await endSession(db, live.id, 'exit');
    expect(await resolveSessionForMcp(db, { agentId: agent.id, sessionRef: old.ref, mcpSessionId: 'm-z2' })).toBeNull();
  });

  it('rule 3 with a project: binds the single active session only when it belongs to that project', async () => {
    const { agent } = await createAgent(db, { name: 'a9', kind: 'claude_code' });
    const { session, project } = await startSession(db, { agentId: agent.id, agentSessionId: 'p1', source: 'startup', cwd: '/w', repo });
    const other = await startSession(db, {
      agentId: (await createAgent(db, { name: 'a9-other', kind: 'codex' })).agent.id, agentSessionId: 'p-other', source: 'startup', cwd: '/o',
      repo: { remote: 'git@github.com:me/other-proj.git', rootName: 'other', rootPathHash: 'o1', branch: 'main' },
    });
    expect(other.project.id).not.toBe(project.id);
    // a process without a session of its own (non-git dir, conus disable) passes another project: no binding
    expect(await resolveSessionForMcp(db, { agentId: agent.id, mcpSessionId: 'm-p1', projectId: other.project.id })).toBeNull();
    const { rows } = await db.query('SELECT mcp_session_ids FROM sessions WHERE id = $1', [session.id]);
    expect(rows[0].mcp_session_ids).not.toContain('m-p1');
    // the same project binds as before; no project keeps the old behaviour
    expect((await resolveSessionForMcp(db, { agentId: agent.id, mcpSessionId: 'm-p2', projectId: project.id }))?.id).toBe(session.id);
    expect((await resolveSessionForMcp(db, { agentId: agent.id, mcpSessionId: 'm-p3' }))?.id).toBe(session.id);
  });

  it('keeps one mcp id bound to one session of an agent: the latest explicit binding wins', async () => {
    const { agent } = await createAgent(db, { name: 'a7', kind: 'claude_code' });
    const { session: a } = await startSession(db, { agentId: agent.id, agentSessionId: 'y1', source: 'startup', cwd: '/w', repo });
    const { session: b } = await startSession(db, { agentId: agent.id, agentSessionId: 'y2', source: 'startup', cwd: '/w', repo });
    expect((await resolveSessionForMcp(db, { agentId: agent.id, sessionRef: a.ref, mcpSessionId: 'm-y' }))?.id).toBe(a.id);
    expect((await resolveSessionForMcp(db, { agentId: agent.id, sessionRef: b.ref, mcpSessionId: 'm-y' }))?.id).toBe(b.id);
    await touchSession(db, a.id); // A is now the most recently seen
    expect((await resolveSessionForMcp(db, { agentId: agent.id, mcpSessionId: 'm-y' }))?.id).toBe(b.id);
    const { rows } = await db.query('SELECT mcp_session_ids FROM sessions WHERE id = $1', [a.id]);
    expect(rows[0].mcp_session_ids).not.toContain('m-y');
  });
});
