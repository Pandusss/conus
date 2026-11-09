import type { Db, Queryable } from '../db';
import { getSettings, localClock } from '../settings';
import { managerSetPriority } from '../tasks/owner-ops';
import { PRIORITY_ORDER, TASK_VIEW_SELECT, mapTaskView } from '../tasks/queries';
import { truncate } from '../text';
import type { Priority, TaskView } from '../types';
import { requireManager, type ManagerLlm, type ReviewTaskInput } from './llm';

const MAX_TASKS = 400;
const DAY = 86_400_000;

export interface ReviewFocus { taskId: string; ref: string; title: string; why: string }
export interface ReviewChange { taskId: string; ref: string; title: string; from: Priority; to: Priority; reason: string; applied: boolean }
export interface ReviewFinding { kind: 'duplicate' | 'stale' | 'unclear' | 'risk'; refs: string[]; note: string }
export interface ManagerReview {
  id: number; trigger: 'daily' | 'owner'; model: string; summary: string;
  focus: ReviewFocus[]; changes: ReviewChange[]; findings: ReviewFinding[]; createdAt: Date;
}

const mapReview = (r: any): ManagerReview => ({
  id: r.id, trigger: r.trigger, model: r.model, summary: r.summary, focus: r.focus, changes: r.changes, findings: r.findings, createdAt: r.created_at,
});

export async function latestReview(q: Queryable): Promise<ManagerReview | null> {
  const { rows } = await q.query('SELECT * FROM manager_reviews ORDER BY id DESC LIMIT 1');
  return rows[0] ? mapReview(rows[0]) : null;
}

/**
 * The manager reviews every open task: priorities that look wrong (changed when the owner allows it, never ones the
 * owner set), what to focus on today, and notes (duplicates, stale or vague tasks, deadlines at risk). The result is
 * kept, so the overview, the digest and agents' session context can show it.
 */
export async function runReview(
  deps: { db: Db; llm: ManagerLlm; now?: Date }, trigger: 'daily' | 'owner',
): Promise<ManagerReview> {
  requireManager(deps.llm);
  const { db } = deps;
  const now = deps.now ?? new Date();
  const settings = await getSettings(db);
  const { rows } = await db.query(
    `${TASK_VIEW_SELECT} WHERE t.deleted_at IS NULL AND t.status IN ('todo','in_progress','blocked','review')
     ORDER BY ${PRIORITY_ORDER}, t.updated_at DESC LIMIT ${MAX_TASKS}`,
  );
  const open: TaskView[] = rows.map(mapTaskView);
  const byRef = new Map(open.map((x) => [x.ref.toUpperCase(), x]));
  const today = localClock(now, settings.timeZone).date;

  let summary: string;
  let focus: ReviewFocus[] = [];
  const changes: ReviewChange[] = [];
  let findings: ReviewFinding[] = [];
  if (!open.length) {
    summary = '—';
  } else {
    const tasks: ReviewTaskInput[] = open.map((x) => ({
      ref: x.ref, project: x.projectName, title: truncate(x.title, 160), status: x.status, priority: x.priority,
      pinned: x.prioritySource === 'owner', dueOn: x.dueOn,
      ageDays: Math.floor((now.getTime() - x.createdAt.getTime()) / DAY),
      idleDays: Math.floor((now.getTime() - x.updatedAt.getTime()) / DAY),
      blockReason: x.blockReason ? truncate(x.blockReason, 200) : null,
      holder: x.holder?.agentName ?? null,
      source: x.sourceQuote ? truncate(x.sourceQuote, 200) : null,
    }));
    const r = await deps.llm.review({ today, timeZone: settings.timeZone, tasks });
    summary = truncate(r.summary, 2000);
    const known = (ref: string) => byRef.get(ref.trim().toUpperCase());
    focus = r.focus.slice(0, 5).flatMap((f) => {
      const x = known(f.ref);
      return x ? [{ taskId: x.id, ref: x.ref, title: x.title, why: truncate(f.why, 300) }] : [];
    });
    findings = r.findings.slice(0, 10).flatMap((f) => {
      const refs = f.refs.map((ref) => known(ref)?.ref).filter((ref): ref is string => !!ref);
      return refs.length ? [{ kind: f.kind, refs, note: truncate(f.note, 400) }] : [];
    });
    for (const p of r.priorities) {
      const x = known(p.ref);
      if (!x || x.prioritySource === 'owner' || x.priority === p.priority) continue;
      const reason = truncate(p.reason, 300);
      let applied = false;
      if (settings.managerAuto) {
        const res = await managerSetPriority({ db, actor: { kind: 'manager' } }, { taskId: x.id, priority: p.priority, reason });
        applied = res.changed;
        if (!res.changed) continue; // the owner pinned it meanwhile, or it closed
      }
      changes.push({ taskId: x.id, ref: x.ref, title: x.title, from: x.priority, to: p.priority, reason, applied });
    }
  }

  const ins = await db.query(
    `INSERT INTO manager_reviews(trigger, model, summary, focus, changes, findings) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [trigger, deps.llm.model, summary, JSON.stringify(focus), JSON.stringify(changes), JSON.stringify(findings)],
  );
  await db.query('UPDATE owner_settings SET last_review_on = $1 WHERE id = 1', [today]);
  return mapReview(ins.rows[0]);
}

/** The latest review's focus in one project, if the review is from the last day and a half. */
export async function projectFocus(q: Queryable, projectId: string, now: Date = new Date()): Promise<ReviewFocus[]> {
  const r = await latestReview(q);
  if (!r || now.getTime() - r.createdAt.getTime() > 36 * 3_600_000 || !r.focus.length) return [];
  const { rows } = await q.query(
    `SELECT id FROM tasks WHERE id = ANY($1) AND project_id = $2 AND deleted_at IS NULL AND status IN ('todo','in_progress','blocked','review')`,
    [r.focus.map((f) => f.taskId), projectId],
  );
  const here = new Set(rows.map((x) => x.id as string));
  return r.focus.filter((f) => here.has(f.taskId));
}
