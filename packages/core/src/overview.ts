import type { Queryable } from './db';
import { PRIORITY_ORDER, TASK_VIEW_SELECT, mapTaskView } from './tasks/queries';
import type { Status, TaskView } from './types';

/** A task as the overview lists it: no long texts. */
export type OverviewTask = Omit<TaskView, 'description' | 'sourceQuote' | 'result'>;
export interface LiveSession { id: string; ref: string; agentName: string; lastSeenAt: Date }
export type OpenStatus = Extract<Status, 'proposed' | 'todo' | 'in_progress' | 'blocked' | 'review'>;

export interface ProjectOverview {
  id: string; key: string; name: string;
  counts: Record<OpenStatus, number>;
  doneThisWeek: number;
  /** The latest task change or agent session in the project. */
  lastActivityAt: Date | null;
  /** When an agent was last seen in the project. The owner's own edits do not count, so this tells a stalled project
   * from one that is moving. */
  lastAgentAt: Date | null;
  /** Since when the longest-waiting task has been waiting for the owner's check. */
  reviewSince: Date | null;
  /** Agent sessions working in the project right now. */
  live: LiveSession[];
  inProgress: OverviewTask[]; blocked: OverviewTask[];
  /** Waiting for the owner's check, longest waiting first. */
  review: OverviewTask[];
  /** The to-do tasks to take next: most urgent first, then the nearest due date. */
  next: OverviewTask[];
  /** No open work and nothing happened for 30 days. */
  quiet: boolean;
}

export interface Overview {
  projects: ProjectOverview[];
  /** What waits for the owner, across projects. */
  attention: {
    /** Waiting for the owner's check, longest waiting first. */
    review: OverviewTask[];
    /** Agents stopped on these; most urgent first. */
    blocked: OverviewTask[];
    /** Open tasks with a due date, nearest first (the UI decides what is overdue in the owner's time zone). */
    dated: OverviewTask[];
    proposals: number;
  };
}

const OPEN: OpenStatus[] = ['proposed', 'todo', 'in_progress', 'blocked', 'review'];
const QUIET_AFTER_MS = 30 * 86_400_000;
const PER_PROJECT = { inProgress: 5, blocked: 3, review: 3, next: 3 };
const ATTENTION_MAX = 20;

const slim = ({ description: _d, sourceQuote: _s, result: _r, ...rest }: TaskView): OverviewTask => rest;
const latest = (...dates: (Date | null | undefined)[]): Date | null =>
  dates.reduce<Date | null>((a, d) => (d && (!a || d > a) ? d : a), null);

/** Every project's state on one screen, plus what waits for the owner. */
export async function getOverview(db: Queryable, now: Date = new Date()): Promise<Overview> {
  const [projects, tasks, done, touched, sessions, seen] = await Promise.all([
    db.query('SELECT id, key, name FROM projects ORDER BY key'),
    db.query(`${TASK_VIEW_SELECT} WHERE t.deleted_at IS NULL AND t.status = ANY($1) ORDER BY ${PRIORITY_ORDER}, t.updated_at DESC LIMIT 3000`, [OPEN]),
    db.query(`SELECT project_id, count(*)::int AS n FROM tasks
              WHERE status = 'done' AND deleted_at IS NULL AND closed_at > $1 GROUP BY project_id`, [new Date(now.getTime() - 7 * 86_400_000)]),
    db.query('SELECT project_id, max(updated_at) AS at FROM tasks WHERE deleted_at IS NULL GROUP BY project_id'),
    db.query(`SELECT s.id, s.ref, s.project_id, s.last_seen_at, a.name AS agent_name
              FROM sessions s JOIN agents a ON a.id = s.agent_id
              WHERE s.project_id IS NOT NULL AND s.state = 'active'
              ORDER BY s.last_seen_at DESC`),
    db.query('SELECT project_id, max(last_seen_at) AS at FROM sessions WHERE project_id IS NOT NULL GROUP BY project_id'),
  ]);
  const open = tasks.rows.map(mapTaskView).map(slim);
  const doneBy = new Map<string, number>(done.rows.map((r) => [r.project_id, r.n]));
  const touchedBy = new Map<string, Date>(touched.rows.map((r) => [r.project_id, r.at]));
  const seenBy = new Map<string, Date>(seen.rows.map((r) => [r.project_id, r.at]));
  const liveBy = new Map<string, LiveSession[]>();
  for (const s of sessions.rows) {
    const list = liveBy.get(s.project_id) ?? [];
    list.push({ id: s.id, ref: s.ref, agentName: s.agent_name, lastSeenAt: s.last_seen_at });
    liveBy.set(s.project_id, list);
  }

  const byUpdated = (a: OverviewTask, b: OverviewTask) => a.updatedAt.getTime() - b.updatedAt.getTime();
  const result: ProjectOverview[] = projects.rows.map((p) => {
    const mine = open.filter((t) => t.projectId === p.id);
    const of = (s: OpenStatus) => mine.filter((t) => t.status === s);
    const counts = Object.fromEntries(OPEN.map((s) => [s, of(s).length])) as Record<OpenStatus, number>;
    const lastAgentAt = seenBy.get(p.id) ?? null;
    const lastActivityAt = latest(touchedBy.get(p.id), lastAgentAt);
    const working = counts.todo + counts.in_progress + counts.blocked + counts.review;
    const review = of('review').sort(byUpdated);
    return {
      id: p.id, key: p.key, name: p.name, counts,
      doneThisWeek: doneBy.get(p.id) ?? 0,
      lastActivityAt,
      lastAgentAt,
      reviewSince: review[0]?.updatedAt ?? null,
      live: liveBy.get(p.id) ?? [],
      inProgress: of('in_progress').slice(0, PER_PROJECT.inProgress),
      blocked: of('blocked').slice(0, PER_PROJECT.blocked),
      review: review.slice(0, PER_PROJECT.review),
      next: of('todo').slice(0, PER_PROJECT.next),
      quiet: working === 0 && (!lastActivityAt || now.getTime() - lastActivityAt.getTime() > QUIET_AFTER_MS),
    };
  });
  // Live work first, then projects with urgent or high-priority work, then where an agent worked most recently
  // (the owner's own edits do not move a project up).
  const pressing = (p: ProjectOverview) => open.filter((t) => t.projectId === p.id && t.status !== 'proposed' && (t.priority === 'urgent' || t.priority === 'high')).length;
  result.sort((a, b) =>
    Number(b.live.length > 0) - Number(a.live.length > 0)
    || pressing(b) - pressing(a)
    || (b.lastAgentAt?.getTime() ?? 0) - (a.lastAgentAt?.getTime() ?? 0)
    || (b.lastActivityAt?.getTime() ?? 0) - (a.lastActivityAt?.getTime() ?? 0)
    || a.key.localeCompare(b.key));

  return {
    projects: result,
    attention: {
      review: open.filter((t) => t.status === 'review').sort(byUpdated).slice(0, ATTENTION_MAX),
      blocked: open.filter((t) => t.status === 'blocked').slice(0, ATTENTION_MAX),
      dated: open.filter((t) => t.dueOn && t.status !== 'proposed')
        .sort((a, b) => a.dueOn!.localeCompare(b.dueOn!)).slice(0, ATTENTION_MAX),
      proposals: open.filter((t) => t.status === 'proposed').length,
    },
  };
}
