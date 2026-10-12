import { sameCommitSql } from './commits';
import type { Queryable } from './db';
import type { Fact } from './types';

export const EXCERPT_MAX = 2000;

export interface TurnActivity {
  files: string[];
  commits: { sha: string; subject: string; branch?: string; amends?: string }[];
  tests: { passed: boolean | null; command: string }[];
  taskOps: { tool: string; task?: string }[];
  prompt: string | null;
  answer: string | null;
}

export async function recordFacts(q: Queryable, sessionId: string, facts: Fact[]): Promise<void> {
  for (const f of facts) {
    if (f.kind === 'git_commit') {
      // One commit is one fact per session: the Stop hook reports a commit whose async PostToolUse fact arrives late
      // (or is replayed from conus's outbox, or arrives with a short sha). Only the first report counts.
      await q.query(
        `INSERT INTO session_activity(session_id, turn, kind, data)
         SELECT $1, current_turn, 'git_commit', $2 FROM sessions WHERE id = $1
           AND NOT EXISTS (SELECT 1 FROM session_activity a WHERE a.session_id = $1 AND a.kind = 'git_commit'
                             AND ${sameCommitSql(`a.data->>'sha'`, '$3::text')})`,
        [sessionId, JSON.stringify(f.data), f.data.sha],
      );
      continue;
    }
    await q.query(
      `INSERT INTO session_activity(session_id, turn, kind, data)
       SELECT $1, current_turn, $2, $3 FROM sessions WHERE id = $1`,
      [sessionId, f.kind, JSON.stringify(f.data)],
    );
  }
}

export async function recordExcerpt(q: Queryable, sessionId: string, kind: 'prompt_excerpt' | 'answer_excerpt', text: string): Promise<void> {
  let t = text.trim().slice(0, EXCERPT_MAX);
  // Do not leave half of a surrogate pair at the cut: a lone surrogate makes the jsonb insert fail.
  const last = t.charCodeAt(t.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) t = t.slice(0, -1);
  if (!t) return;
  await q.query(
    `INSERT INTO session_activity(session_id, turn, kind, data) SELECT $1, current_turn, $2, $3 FROM sessions WHERE id = $1`,
    [sessionId, kind, JSON.stringify({ text: t })],
  );
}

export async function getTurnActivity(q: Queryable, sessionId: string, turn: number): Promise<TurnActivity> {
  const { rows } = await q.query('SELECT kind, data FROM session_activity WHERE session_id = $1 AND turn = $2 ORDER BY id', [sessionId, turn]);
  const a: TurnActivity = { files: [], commits: [], tests: [], taskOps: [], prompt: null, answer: null };
  for (const r of rows) {
    if (r.kind === 'file_edit' && !a.files.includes(r.data.path)) a.files.push(r.data.path);
    else if (r.kind === 'git_commit' && !a.commits.some((c) => c.sha === r.data.sha)) a.commits.push(r.data);
    else if (r.kind === 'test_run') a.tests.push(r.data);
    else if (r.kind === 'task_op') a.taskOps.push(r.data);
    else if (r.kind === 'prompt_excerpt') a.prompt = r.data.text;
    else if (r.kind === 'answer_excerpt') a.answer = r.data.text;
  }
  return a;
}

export async function filesSinceLastTaskOp(q: Queryable, sessionId: string): Promise<string[]> {
  const { rows } = await q.query(
    `SELECT DISTINCT data->>'path' AS path FROM session_activity
     WHERE session_id = $1 AND kind = 'file_edit'
       AND id > COALESCE((SELECT max(id) FROM session_activity WHERE session_id = $1 AND kind = 'task_op'), 0)
     ORDER BY 1`,
    [sessionId],
  );
  return rows.map((r) => r.path as string);
}

export async function workEvidenceSince(
  q: Queryable, sessionId: string, since: Date,
): Promise<{ files: string[]; commits: { sha: string; subject: string }[]; lastAnswer: string | null }> {
  const { rows } = await q.query(
    `SELECT kind, data FROM session_activity WHERE session_id = $1 AND created_at >= $2
       AND kind IN ('file_edit','git_commit','answer_excerpt') ORDER BY id`,
    [sessionId, since],
  );
  const files: string[] = [];
  const commits: { sha: string; subject: string }[] = [];
  let lastAnswer: string | null = null;
  for (const r of rows) {
    if (r.kind === 'file_edit' && !files.includes(r.data.path)) files.push(r.data.path);
    if (r.kind === 'git_commit' && !commits.some((c) => c.sha === r.data.sha)) commits.push(r.data);
    if (r.kind === 'answer_excerpt') lastAnswer = r.data.text;
  }
  return { files, commits, lastAnswer };
}
