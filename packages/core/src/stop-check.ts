import { createHash } from 'node:crypto';
import { sameCommitSql } from './commits';
import type { Db } from './db';
import { filesSinceLastTaskOp, getTurnActivity, recordExcerpt, type TurnActivity } from './activity';
import type { Judge, JudgeVerdict, TaskBrief } from './judge-types';
import { truncate } from './text';
import { linkCommit } from './tasks/lifecycle';
import { listClaimedTasks, listSessionTasks, listTasks } from './tasks/queries';
import { OPEN_STATUSES, type Actor, type Session, type Task } from './types';
import { t } from './lang';

export const NUDGE_LIMIT_PER_SESSION = 8;
/** A judge nudge reaches the agent as the Stop block reason: at most this long, escape hatch included. */
export const JUDGE_REASON_MAX = 400;
export type StopDecision = { action: 'ok' } | { action: 'nudge'; reason: string };
const OK: StopDecision = { action: 'ok' };
const escape = () => t(' If everything is up to date, just finish your reply without mentioning tasks.', ' Если всё актуально — просто заверши ответ, ничего не говоря о задачах.');

const MARKERS = [
  'делаем', 'давай', 'договорились', 'не будем', 'не надо', 'отказ', 'откат', 'отмен', 'забудь',
  "let's", 'lets do', 'go ahead', "won't", 'will not', "don't do", 'drop it', 'cancel', 'revert', 'scrap',
];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Unicode-aware left boundary: JS \b is ASCII-only and never fires before Cyrillic letters.
export const DECISION_MARKERS = new RegExp(`(?:^|[^\\p{L}])(?:${MARKERS.map(esc).join('|')})`, 'iu');

const brief = (t: Task): TaskBrief => ({ ref: t.ref, title: t.title, status: t.status });
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

async function issueNudge(
  db: Db, session: Session, rule: 'D1' | 'JUDGE', reason: string, refs: string[], signature: string,
): Promise<StopDecision> {
  const r = await db.query(
    `INSERT INTO nudges(session_id, turn, rule, reason, task_refs, signature) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (session_id, signature) DO NOTHING`,
    [session.id, session.currentTurn, rule, reason, refs, signature],
  );
  return r.rowCount ? { action: 'nudge', reason } : OK;
}

function d1Reason(files: string[], commits: TurnActivity['commits']): string {
  const list = files.slice(0, 5).join(', ') + (files.length > 5 ? '…' : '');
  const parts = [
    files.length ? t(`several files changed (${list})`, `изменено несколько файлов (${list})`) : null,
    commits.length ? t(`commit ${commits[0]!.sha.slice(0, 7)} made`, `есть коммит ${commits[0]!.sha.slice(0, 7)}`) : null,
  ].filter(Boolean).join(', ');
  const what = parts.charAt(0).toUpperCase() + parts.slice(1);
  return t(
    `${what}, but the work is not linked to a Conus task. If it is a main task, link it to an existing one (task_start) or create one (task_create with start_now=true). If it is a small thing, just finish your reply without mentioning tasks.`,
    `${what}, но работа не привязана к задаче Conus. Если это основная задача — привяжи её к существующей (task_start) или создай новую (task_create с start_now=true). Если это мелочь — просто заверши ответ, ничего не говоря о задачах.`,
  );
}

/** Below this many files edited since the session's last task op, a commit after a close is "commit it". */
const AFTER_CLOSE_MAX_FILES = 3;

/**
 * The task a commit without a task in progress belongs to: the one this session has just closed. That is
 * the session's latest task event (notes on it, and the commit links made here, keep it so), the task is
 * in the session's project, still done/review, and its last close (`completed`/`sent_to_review`) was by
 * this session. The usual order is "done and verified → task_complete", then the user says "commit it"
 * (live run, Task 21). Bounded: with ≥ 3 distinct files edited since the session's last task op the commit
 * is new, separate work, and D1 applies as usual. Null otherwise.
 */
async function justClosedBySession(db: Db, session: Session): Promise<string | null> {
  if (!session.projectId) return null;
  if ((await filesSinceLastTaskOp(db, session.id)).length >= AFTER_CLOSE_MAX_FILES) return null;
  const { rows } = await db.query(
    `WITH last AS (
       SELECT task_id FROM task_events WHERE session_id = $1 AND actor_kind = 'agent' ORDER BY id DESC LIMIT 1
     )
     SELECT t.id FROM last JOIN tasks t ON t.id = last.task_id
     WHERE t.project_id = $2 AND t.status IN ('done','review') AND t.deleted_at IS NULL
       AND (SELECT e.session_id FROM task_events e WHERE e.task_id = t.id AND e.type IN ('completed','sent_to_review')
            ORDER BY e.seq DESC LIMIT 1) = $1`,
    [session.id, session.projectId],
  );
  return rows[0]?.id ?? null;
}

/**
 * For each commit of the turn, the ids of the tasks (of the session's project, not deleted) that already link it,
 * matched by sha prefix: a commit linked by `task_complete` with a short sha counts.
 */
async function commitLinks(db: Db, projectId: string | null, commits: TurnActivity['commits']): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (!commits.length) return out;
  const { rows } = await db.query(
    `SELECT c.sha, l.task_id FROM unnest($1::text[]) AS c(sha)
     JOIN links l ON l.kind = 'commit' AND ${sameCommitSql('l.ref', 'c.sha')}
     JOIN tasks t ON t.id = l.task_id AND t.deleted_at IS NULL AND ($2::uuid IS NULL OR t.project_id = $2::uuid)`,
    [commits.map((c) => c.sha), projectId],
  );
  for (const r of rows) {
    const set = out.get(r.sha) ?? new Set<string>();
    set.add(r.task_id);
    out.set(r.sha, set);
  }
  return out;
}

/** Id of the session's latest task_op row: a D1 nudge is issued at most once per such "epoch". */
async function latestTaskOpId(db: Db, sessionId: string): Promise<string> {
  const { rows } = await db.query(
    `SELECT max(id) AS id FROM session_activity WHERE session_id = $1 AND kind = 'task_op'`, [sessionId],
  );
  return rows[0]?.id == null ? 'none' : String(rows[0].id);
}

export async function evaluateStop(
  deps: { db: Db; judge: Judge },
  input: { session: Session; stopHookActive: boolean; answerExcerpt?: string | null },
): Promise<StopDecision> {
  const { db, judge } = deps;
  const session = input.session;
  if (input.answerExcerpt) await recordExcerpt(db, session.id, 'answer_excerpt', input.answerExcerpt);
  await db.query(
    `UPDATE nudges n SET acted = true WHERE n.session_id = $1 AND NOT n.acted AND EXISTS (
       SELECT 1 FROM session_activity a WHERE a.session_id = n.session_id AND a.kind = 'task_op' AND a.created_at > n.created_at)`,
    [session.id],
  );

  const act = await getTurnActivity(db, session.id, session.currentTurn);
  const claimed = await listClaimedTasks(db, session.id);
  const actor: Actor = { kind: 'agent', agentId: session.agentId, sessionId: session.id, model: session.model };

  // A commit some task already links is never linked to another task, and never counts as unlinked work for D1
  // (task_complete named it, or it was linked in an earlier turn and reported again).
  const links = await commitLinks(db, session.projectId, act.commits);
  const unlinked = act.commits.filter((c) => !links.get(c.sha)?.size);
  const linkableTo = (taskId: string) => act.commits.filter((c) => !links.get(c.sha)?.size || links.get(c.sha)!.has(taskId));
  const link = (taskId: string, c: TurnActivity['commits'][number]) =>
    linkCommit({ db, actor }, { taskId, sha: c.sha, subject: c.subject, amends: c.amends, branch: c.branch });

  // D2: commits are linked to the task(s) in progress — no model involvement, and never gated by
  // nudging (stop_hook_active / the per-session cap only limit nudges, not bookkeeping).
  // Without a task in progress, commits go to the task this session has just closed (see justClosedBySession).
  let linkedToClosed = false;
  if (act.commits.length && claimed.length) {
    for (const t of claimed) for (const c of linkableTo(t.id)) await link(t.id, c);
  } else if (act.commits.length) {
    const closed = await justClosedBySession(db, session);
    if (closed) {
      for (const c of linkableTo(closed)) await link(closed, c);
      linkedToClosed = true;
    }
  }

  if (input.stopHookActive) return OK;
  const { rows } = await db.query('SELECT count(*)::int AS n FROM nudges WHERE session_id = $1', [session.id]);
  if (rows[0].n >= NUDGE_LIMIT_PER_SESSION) return OK;

  // D1: significant unlinked work — at most one nudge per task-op epoch, and only for a turn that
  // itself edited files or committed. A duplicate (or non-triggering) D1 falls through to the judge.
  if (!claimed.length && !act.taskOps.length && !linkedToClosed && (act.files.length || unlinked.length)) {
    const files = await filesSinceLastTaskOp(db, session.id);
    if (unlinked.length || files.length >= 3) {
      const sig = 'D1:' + (await latestTaskOpId(db, session.id));
      const d1 = await issueNudge(db, session, 'D1', d1Reason(files, unlinked), [], sig);
      if (d1.action === 'nudge') return d1;
    }
  }

  if (!judge.enabled || !session.projectId) return OK;
  const progressSignal = act.commits.length > 0 || act.tests.some((t) => t.passed === true);
  const sessionTasks = await listSessionTasks(db, session.id);
  const blockedHere = sessionTasks.filter((t) => t.status === 'blocked');
  const ask =
    (claimed.length > 0 && act.taskOps.length === 0 && progressSignal) ||
    (!!act.prompt && DECISION_MARKERS.test(act.prompt)) ||
    (blockedHere.length > 0 && progressSignal);
  if (!ask) return OK;

  const open = await listTasks(db, { projectId: session.projectId, statuses: OPEN_STATUSES, limit: 30 });
  let verdict: JudgeVerdict;
  try {
    verdict = await judge.evaluate({
      prompt: act.prompt,
      answer: act.answer,
      activity: { files: act.files, commits: act.commits, tests: act.tests.map((t) => ({ passed: t.passed })) },
      turnTaskOps: act.taskOps.map((o) => (o.task ? `${o.tool} ${o.task}` : o.tool)),
      sessionTasks: sessionTasks.map(brief),
      openTasks: open.map(brief),
    });
  } catch {
    return OK; // any judge failure ⇒ ok
  }
  if (verdict.verdict !== 'nudge' || !verdict.reason.trim()) return OK;
  const refs = [...new Set(verdict.taskRefs)].sort();
  const sig = refs.length ? `JUDGE:${refs.join(',')}` : `JUDGE:#${hash(verdict.reason)}`;
  const reason = truncate(verdict.reason.trim(), JUDGE_REASON_MAX - escape().length) + escape();
  return issueNudge(db, session, 'JUDGE', reason, refs, sig);
}
