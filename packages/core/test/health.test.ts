import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../../../test/helpers/db';
import { seedAgentSession } from '../../../test/helpers/fixtures';
import type { Db } from '../src/db';
import { createAgent, markUnboundMcp } from '../src/agents';
import { agentHealthRollup, getSessionOverview, healthWarnings, listSessionSummaries } from '../src/health';
import { createTask } from '../src/tasks/create';
import { runJanitor } from '../src/janitor';
import { NullJudge } from '../src/judge-types';
import { endSession } from '../src/sessions';

let db: Db; let drop: () => Promise<void>;
beforeAll(async () => ({ db, drop } = await createTestDb()));
afterAll(async () => drop());

describe('health', () => {
  it('warns about agents calling MCP without hooks', async () => {
    const { agent } = await createAgent(db, { name: 'codex@pc', kind: 'codex' });
    expect(await healthWarnings(db)).toEqual([]);
    await markUnboundMcp(db, agent.id);
    const w = await healthWarnings(db);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ kind: 'hooks_missing', agentName: 'codex@pc' });
  });

  it('does not warn about hooks when a session started days ago is still seen', async () => {
    const s = await seedAgentSession(db, { agentName: 'long@pc', remote: 'git@github.com:me/long.git' });
    await db.query(`UPDATE sessions SET started_at = now() - interval '2 days' WHERE id = $1`, [s.session.id]);
    await markUnboundMcp(db, s.agent.id);
    expect((await healthWarnings(db)).filter((w) => w.agentId === s.agent.id)).toEqual([]);

    // The same session gone quiet for over a day: the unbound call is the only sign of life.
    await db.query(`UPDATE sessions SET last_seen_at = now() - interval '2 days' WHERE id = $1`, [s.session.id]);
    expect((await healthWarnings(db)).filter((w) => w.agentId === s.agent.id)).toMatchObject([{ kind: 'hooks_missing' }]);
  });

  it('summarizes sessions with ops, nudges and janitor releases', async () => {
    const s = await seedAgentSession(db, { remote: 'git@github.com:me/h.git' });
    await createTask({ db, actor: s.actor }, { projectId: s.project.id, title: 'Work', startNow: true });
    await db.query(`INSERT INTO session_activity(session_id, turn, kind, data) VALUES ($1, 0, 'task_op', '{"tool":"task_create"}')`, [s.session.id]);
    await db.query(`INSERT INTO nudges(session_id, turn, rule, reason, signature, acted) VALUES ($1, 0, 'D1', 'r', 'sig', true)`, [s.session.id]);
    await endSession(db, s.session.id, 'exit');
    await runJanitor({ db, judge: new NullJudge() });
    const [sum] = (await listSessionSummaries(db)).filter((x) => x.id === s.session.id);
    expect(sum).toMatchObject({ ref: s.session.ref, taskOps: 1, nudges: 1, nudgesActed: 1, janitorReleases: 1, state: 'ended' });
    const ov = await getSessionOverview(db, s.session.id);
    expect(ov?.events.map((e) => e.type)).toEqual(['created', 'claimed']);
    expect(ov?.janitor.map((e) => e.type)).toEqual(['claim_released']);
    expect(ov?.nudges).toHaveLength(1);
  });

  it('rolls up per-agent stats over the window and warns about repeated janitor interventions', async () => {
    const s = await seedAgentSession(db, { agentName: 'sloppy@box', remote: 'git@github.com:me/roll.git' });
    for (const title of ['Alpha parser rewrite', 'Beta cache layer', 'Gamma metrics export']) {
      await createTask({ db, actor: s.actor }, { projectId: s.project.id, title, startNow: true, confirmNew: { reason: 't' } });
    }
    await db.query(`INSERT INTO nudges(session_id, turn, rule, reason, signature, acted) VALUES ($1, 0, 'D1', 'r', 'a', true), ($1, 1, 'JUDGE', 'r', 'b', false)`, [s.session.id]);
    const before = await healthWarnings(db);
    expect(before.filter((w) => w.agentId === s.agent.id)).toEqual([]);

    await endSession(db, s.session.id, 'exit');
    await runJanitor({ db, judge: new NullJudge() });

    const rollup = await agentHealthRollup(db);
    expect(rollup.find((r) => r.agentId === s.agent.id)).toEqual({
      agentId: s.agent.id, sessions: 1, nudges: 2, nudgesActed: 1, janitorReleases: 3,
    });
    // Agents without sessions are present with zeros.
    expect(rollup.find((r) => r.agentId !== s.agent.id && r.sessions === 0)).toMatchObject({ nudges: 0, nudgesActed: 0, janitorReleases: 0 });

    const w = (await healthWarnings(db)).filter((x) => x.agentId === s.agent.id);
    expect(w).toEqual([{
      kind: 'janitor_interventions', agentId: s.agent.id, agentName: 'sloppy@box', count: 3, days: 7,
      message: 'Agent sloppy@box: the server released its tasks 3 times after its sessions in 7 days — the agent does not close its work itself.',
    }]);

    // Outside the window (8 days later) nothing counts any more.
    const later = new Date(Date.now() + 8 * 86_400_000);
    expect((await agentHealthRollup(db, later)).find((r) => r.agentId === s.agent.id)).toEqual({
      agentId: s.agent.id, sessions: 0, nudges: 0, nudgesActed: 0, janitorReleases: 0,
    });
    expect((await healthWarnings(db, later)).filter((x) => x.kind === 'janitor_interventions')).toEqual([]);
  });
});
