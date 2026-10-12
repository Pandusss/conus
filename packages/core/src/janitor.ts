import type { Db } from './db';
import { workEvidenceSince } from './activity';
import { fallbackSummary } from './judge';
import type { Judge } from './judge-types';
import { STALE_AFTER_MS } from './sessions';
import { janitorRelease, releaseUnownedTask } from './tasks/lifecycle';
import { getTaskById } from './tasks/queries';
import { t } from './lang';

/** An in_progress task nobody claims goes back to todo after this long without a task event (spec §9.2). */
// A day, not the 30-minute claim TTL: a sessionless agent can work for hours between two MCP calls.
export const UNOWNED_IDLE_MS = 24 * 60 * 60 * 1000;
export const unownedReleaseNote = () => t(
  'Reconciliation (system): the task was In progress with no owning session and no events for over a day — moved back to To do.',
  'Сверка (система): задача была «В работе» без сессии-владельца и без событий больше суток — возвращена в «К выполнению».',
);

export async function runJanitor(
  deps: { db: Db; judge: Judge }, now = new Date(),
): Promise<{ staled: number; released: { ref: string; to: 'review' | 'todo' }[] }> {
  const { db, judge } = deps;
  const st = await db.query(`UPDATE sessions SET state = 'stale' WHERE state = 'active' AND last_seen_at < $1`, [
    new Date(now.getTime() - STALE_AFTER_MS),
  ]);
  const { rows } = await db.query(
    `SELECT t.id, t.claimed_by_session_id AS sid,
       (SELECT max(e.created_at) FROM task_events e WHERE e.task_id = t.id AND e.type IN ('created','started','claimed')) AS since
     FROM tasks t JOIN sessions s ON s.id = t.claimed_by_session_id
     WHERE t.status = 'in_progress' AND t.deleted_at IS NULL
       AND (s.state <> 'active' OR t.claim_expires_at < $1)`,
    [now],
  );
  const released: { ref: string; to: 'review' | 'todo' }[] = [];
  for (const r of rows) {
    try {
      const task = await getTaskById(db, r.id);
      if (!task) continue;
      const ev = await workEvidenceSince(db, r.sid, r.since ?? task.createdAt);
      const hasEvidence = ev.files.length > 0 || ev.commits.length > 0;
      let summary: string | null = null;
      if (hasEvidence) {
        const input = { task: { ref: task.ref, title: task.title, description: task.description }, commits: ev.commits, files: ev.files, lastAnswer: ev.lastAnswer };
        let llm: string | null = null;
        if (judge.enabled) {
          try {
            llm = await judge.summarize(input);
          } catch (e) {
            console.error('[janitor] judge.summarize failed, using fallback summary', r.id, e);
          }
        }
        summary = `${t('Auto summary (system)', 'Автосводка (система)')}: ${llm ?? fallbackSummary(input)}`;
      }
      const res = await janitorRelease(
        { db, actor: { kind: 'system' }, now },
        { taskId: task.id, to: hasEvidence ? 'review' : 'todo', autoSummary: summary, expectedSessionId: r.sid },
      );
      if (res) released.push({ ref: task.ref, to: hasEvidence ? 'review' : 'todo' });
    } catch (e) {
      console.error('[janitor] failed to release task', r.id, e);
    }
  }
  // Backstop: in_progress without a claim (started by an MCP call without a session) and quiet for a day.
  // A task the owner put in progress (latest entry into in_progress by the user) is the owner's and stays.
  const idleSince = new Date(now.getTime() - UNOWNED_IDLE_MS);
  const unowned = await db.query(
    `SELECT t.id FROM tasks t
     WHERE t.status = 'in_progress' AND t.claimed_by_session_id IS NULL AND t.deleted_at IS NULL AND t.updated_at < $1
       AND NOT EXISTS (SELECT 1 FROM task_events e WHERE e.task_id = t.id AND e.created_at >= $1)
       AND COALESCE((SELECT e.actor_kind FROM task_events e WHERE e.task_id = t.id
                       AND (e.changes->'status'->>'to' = 'in_progress' OR e.type = 'claimed')
                     ORDER BY e.seq DESC LIMIT 1), 'agent') <> 'user'`,
    [idleSince],
  );
  for (const r of unowned.rows) {
    try {
      const res = await releaseUnownedTask({ db, actor: { kind: 'system' }, now }, { taskId: r.id, idleSince, note: unownedReleaseNote() });
      if (res) released.push({ ref: res.task.ref, to: 'todo' });
    } catch (e) {
      console.error('[janitor] failed to release unowned task', r.id, e);
    }
  }
  await db.query(`DELETE FROM session_activity WHERE created_at < $1`, [new Date(now.getTime() - 30 * 86_400_000)]);
  await db.query(`DELETE FROM idempotency_keys WHERE created_at < $1`, [new Date(now.getTime() - 7 * 86_400_000)]);
  await db.query(`DELETE FROM owner_sessions WHERE expires_at < $1`, [now]);
  return { staled: st.rowCount ?? 0, released };
}
