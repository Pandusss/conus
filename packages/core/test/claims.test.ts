import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../../../test/helpers/db';
import { seedAgentSession, seedSecondSession } from '../../../test/helpers/fixtures';
import type { Db } from '../src/db';
import { createTask } from '../src/tasks/create';
import { startTask } from '../src/tasks/lifecycle';
import { endSession } from '../src/sessions';

let db: Db; let drop: () => Promise<void>;
beforeAll(async () => ({ db, drop } = await createTestDb()));
afterAll(async () => drop());

const remote = 'git@github.com:me/claims.git';

describe('claims', () => {
  it('parallel start from two sessions: exactly one wins, the other gets conflict_claimed', async () => {
    const a = await seedAgentSession(db, { remote, agentName: 'claude-code@laptop' });
    const b = await seedSecondSession(db, a.agent.id, remote, 'other-ext');
    const r = await createTask({ db, actor: a.actor }, { projectId: a.project.id, title: 'Contended task' });
    if (r.outcome !== 'created') throw new Error();
    const results = await Promise.allSettled([
      startTask({ db, actor: a.actor }, { projectId: a.project.id, task: r.task.ref }),
      startTask({ db, actor: b.actor }, { projectId: a.project.id, task: r.task.ref }),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'conflict_claimed', details: { agentName: 'claude-code@laptop' } });
  });

  it('same session start is a no-op; ended holder can be taken over', async () => {
    const a = await seedAgentSession(db, { remote });
    const b = await seedSecondSession(db, a.agent.id, remote, 'third-ext');
    const r = await createTask({ db, actor: a.actor }, { projectId: a.project.id, title: 'Takeover task' });
    if (r.outcome !== 'created') throw new Error();
    const first = await startTask({ db, actor: a.actor }, { projectId: a.project.id, task: r.task.ref });
    const again = await startTask({ db, actor: a.actor }, { projectId: a.project.id, task: r.task.ref });
    expect(again.task.version).toBe(first.task.version);
    await endSession(db, a.session.id, 'exit');
    const taken = await startTask({ db, actor: b.actor }, { projectId: a.project.id, task: r.task.ref });
    expect(taken.task.claimedBySessionId).toBe(b.session.id);
  });

  it('conflict details name the holder; an expired claim can be taken over even by an active holder', async () => {
    const a = await seedAgentSession(db, { remote, agentName: 'holder@box' });
    const b = await seedSecondSession(db, a.agent.id, remote, 'fourth-ext');
    const r = await createTask({ db, actor: a.actor }, { projectId: a.project.id, title: 'Expiring claim' });
    if (r.outcome !== 'created') throw new Error();
    await startTask({ db, actor: a.actor }, { projectId: a.project.id, task: r.task.ref });
    await expect(startTask({ db, actor: b.actor }, { projectId: a.project.id, task: r.task.ref })).rejects.toMatchObject({
      code: 'conflict_claimed', details: { agentName: 'holder@box', sessionRef: a.session.ref },
    });
    const later = new Date(Date.now() + 31 * 60 * 1000);
    const taken = await startTask({ db, actor: b.actor, now: later }, { projectId: a.project.id, task: r.task.ref });
    expect(taken.task.claimedBySessionId).toBe(b.session.id);
    expect(taken.task.claimExpiresAt!.getTime()).toBeGreaterThan(later.getTime());
  });
});
