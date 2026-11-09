import type { Queryable } from '../db';
import { plural, t } from '../lang';
import { getOverview, type OpenStatus, type Overview, type OverviewTask, type ProjectOverview } from '../overview';
import { getSettings, localClock } from '../settings';
import { TASK_VIEW_SELECT, mapTaskView } from '../tasks/queries';
import { truncate } from '../text';
import type { Priority, Status, TaskView } from '../types';
import { dayDiff, dueWords, esc, fit, heading, link, longDate, pack, priorityName, quote, section, taskLink, under, waitedWords } from './format';
import { latestReview, type ManagerReview, type ReviewChange, type ReviewFinding, type ReviewFocus } from './review';

/** The messages the manager sends to Telegram: the digest, reminders, notices and the review. Layout is in format.ts. */

const LIST = 5;
const PROJECTS = 12;
const DAY = 86_400_000;

// ── pieces shared by the messages ──
type Listed = Pick<TaskView, 'id' | 'ref' | 'title'>;
/** «• CON-12 Title · <i>waiting 2 days</i>» */
const item = (x: Listed, base: string | null, note?: string | null) =>
  `• ${taskLink(x, base)} ${esc(truncate(x.title, 90))}${note ? ` · <i>${esc(note)}</i>` : ''}`;
/** A section of at most `max` lines out of `total`. */
const listed = <T>(head: string, all: T[], total: number, line: (x: T) => string, max = LIST) =>
  section(head, all.slice(0, max).map(line), total - Math.min(all.length, max));
const blockedItem = (x: Listed & { blockReason: string | null }, base: string | null) =>
  item(x, base) + (x.blockReason ? `\n${under(truncate(x.blockReason, 140))}` : '');

/** The overview lists at most twenty tasks for the owner; the projects' counters say how many there really are. */
const count = (o: Overview, s: OpenStatus) => o.projects.reduce((n, p) => n + p.counts[s], 0);

const reviewSection = (o: Overview, base: string | null, now: Date) => {
  const n = count(o, 'review');
  return n ? listed(heading('👀', t('To check', 'Проверить'), n), o.attention.review, n, (x) => item(x, base, waitedWords(x.updatedAt, now))) : '';
};
const blockedSection = (o: Overview, base: string | null) => {
  const n = count(o, 'blocked');
  return n ? listed(heading('⛔', t('Blocked', 'Заблокировано'), n), o.attention.blocked, n, (x) => blockedItem(x, base)) : '';
};
const datedSection = (dated: OverviewTask[], base: string | null, today: string) =>
  (dated.length ? listed(heading('📅', t('Deadlines', 'Сроки')), dated, dated.length, (x) => item(x, base, dueWords(x.dueOn!, today))) : '');
const focusSection = (focus: ReviewFocus[], base: string | null) => (focus.length
  ? section(heading('🎯', t('Focus for today', 'Фокус на сегодня')), focus.map((f, i) =>
    `${i + 1}. ${taskLink({ id: f.taskId, ref: f.ref }, base)} ${esc(truncate(f.title, 80))}\n${under(truncate(f.why, 200))}`))
  : '');

const tasksWait = (n: number) => plural(n,
  [`${n} task waits for you`, `${n} tasks wait for you`],
  [`Тебя ждёт ${n} задача`, `Тебя ждут ${n} задачи`, `Тебя ждут ${n} задач`]);
/** «<a>3 proposals</a> wait for your decision» */
function proposalsPhrase(n: number, base: string | null): string {
  const what = `${n} ${plural(n, ['proposal', 'proposals'], ['предложение', 'предложения', 'предложений'])}`;
  const wait = plural(n, ['waits for your decision', 'wait for your decision'], ['ждёт решения', 'ждут решения', 'ждут решения']);
  return `${base ? link(`${base}/proposals`, what) : what} ${wait}`;
}

function projectLine(p: ProjectOverview): string {
  const c = p.counts;
  const parts = [
    c.in_progress && t(`in progress ${c.in_progress}`, `в работе ${c.in_progress}`),
    c.review && t(`to check ${c.review}`, `на проверке ${c.review}`),
    c.blocked && t(`blocked ${c.blocked}`, `заблокировано ${c.blocked}`),
    c.todo && t(`to do ${c.todo}`, `в очереди ${c.todo}`),
  ].filter(Boolean);
  return `<b>${esc(p.key)}</b> ${esc(truncate(p.name, 40))} — ${parts.length ? parts.join(' · ') : t('nothing open', 'открытых нет')}`;
}

// ── the digest ──
/**
 * The morning digest: the manager's focus for today, what waits for the owner (checks, blockers, deadlines,
 * proposals), work in progress and yesterday's results, then one line per project. `base` is the web app's address
 * for links (see linkBase), or null.
 */
export async function buildDigest(q: Queryable, base: string | null, now: Date = new Date()): Promise<string> {
  const settings = await getSettings(q);
  const today = localClock(now, settings.timeZone).date;
  const o = await getOverview(q, now);
  const review = await latestReview(q);
  const fresh = review && now.getTime() - review.createdAt.getTime() < 20 * 3_600_000 ? review : null;
  const doneRows = await q.query(`${TASK_VIEW_SELECT} WHERE t.status = 'done' AND t.deleted_at IS NULL AND t.closed_at > $1 ORDER BY t.closed_at DESC`,
    [new Date(now.getTime() - DAY)]);
  const done = doneRows.rows.map(mapTaskView);
  const working = o.projects.flatMap((p) => p.inProgress);
  const a = o.attention;
  const dated = a.dated.filter((x) => x.dueOn && dayDiff(today, x.dueOn) <= 1);
  const waits = [
    reviewSection(o, base, now), blockedSection(o, base), datedSection(dated, base, today),
    a.proposals ? `📥 ${proposalsPhrase(a.proposals, base)}` : '',
  ].filter(Boolean);
  const active = o.projects.filter((p) => !p.quiet);
  const hidden = active.length - PROJECTS;

  const title = `☀️ <b>${esc(t(`Digest · ${longDate(today)}`, `Сводка · ${longDate(today)}`))}</b>`;
  return fit([
    fresh?.summary && fresh.summary !== '—' ? `${title}\n${quote(esc(fresh.summary))}` : title,
    focusSection(fresh?.focus ?? [], base),
    ...(waits.length ? waits : [t('✅ Nothing waits for you.', '✅ Тебя ничего не ждёт.')]),
    working.length ? listed(heading('🛠', t('In progress', 'В работе'), count(o, 'in_progress')), working, count(o, 'in_progress'), (x) => item(x, base, x.holder?.agentName)) : '',
    done.length ? listed(heading('✅', t('Done in the last 24 h', 'Готово за сутки'), done.length), done, done.length, (x) => item(x, base)) : '',
    active.length ? `${heading('📊', t('Projects', 'Проекты'))}\n${quote([
      ...active.slice(0, PROJECTS).map(projectLine), ...(hidden > 0 ? [t(`…and ${hidden} more`, `…и ещё ${hidden}`)] : []),
    ].join('\n'))}` : '',
  ]);
}

// ── «what waits for me now»: the reminder between digests and /now ──
export interface NowView {
  text: string;
  /** Nothing waits for the owner and the day's focus is done: not worth a reminder. */
  empty: boolean;
}

const statusWord = (s: Status): string => ({
  proposed: t('a proposal', 'предложение'), todo: t('not started', 'не начата'), in_progress: t('in progress', 'в работе'),
  blocked: t('blocked', 'заблокирована'), review: t('to check', 'на проверке'), done: t('done', 'готова'), dropped: t('dropped', 'отменена'),
})[s];

/**
 * What waits for the owner right now: checks, blockers, deadlines that are due, proposals, and what is left of today's
 * focus. A reminder ('reminder') and the answer to /now ('ask') differ in the first line only.
 */
export async function buildNow(q: Queryable, base: string | null, now: Date = new Date(), kind: 'reminder' | 'ask' = 'ask'): Promise<NowView> {
  const settings = await getSettings(q);
  const today = localClock(now, settings.timeZone).date;
  const o = await getOverview(q, now);
  const a = o.attention;
  // due today or overdue, and not already listed as waiting for a check or blocked
  const dated = a.dated.filter((x) => x.dueOn && dayDiff(today, x.dueOn) <= 0 && x.status !== 'review' && x.status !== 'blocked');
  const waiting = count(o, 'review') + count(o, 'blocked') + dated.length;

  const review = await latestReview(q);
  const focus = review && localClock(review.createdAt, settings.timeZone).date === today ? review.focus : [];
  const statusOf = new Map<string, Status>();
  if (focus.length) {
    const { rows } = await q.query('SELECT id, status FROM tasks WHERE id = ANY($1) AND deleted_at IS NULL', [focus.map((f) => f.taskId)]);
    for (const r of rows) statusOf.set(r.id, r.status);
  }
  const alive = focus.filter((f) => statusOf.has(f.taskId) && statusOf.get(f.taskId) !== 'dropped');
  const left = alive.filter((f) => statusOf.get(f.taskId) !== 'done');
  const closed = (await q.query(
    `SELECT count(*)::int AS n FROM tasks WHERE status = 'done' AND deleted_at IS NULL AND (closed_at AT TIME ZONE $1)::date = $2::date`,
    [settings.timeZone, today],
  )).rows[0].n as number;

  const icon = kind === 'reminder' ? '⏰' : '📌';
  const leftOf = t(`${left.length} of ${alive.length} left`, `осталось ${left.length} из ${alive.length}`);
  const focusLines = left.map((f) => item({ id: f.taskId, ref: f.ref, title: f.title }, base, statusWord(statusOf.get(f.taskId)!)));
  const focusDone = alive.length && !left.length
    ? `🎯 ${t(`Today's focus is done: ${alive.length} of ${alive.length}`, `Фокус на сегодня выполнен: ${alive.length} из ${alive.length}`)}` : '';
  const closedLine = closed ? `✅ ${t(`Closed today: ${closed}`, `Сегодня закрыто: ${closed}`)}` : '';

  let sections: string[];
  if (waiting) {
    sections = [
      `${icon} <b>${esc(tasksWait(waiting))}</b>`,
      reviewSection(o, base, now), blockedSection(o, base), datedSection(dated, base, today),
      a.proposals ? `📥 ${proposalsPhrase(a.proposals, base)}` : '',
      left.length ? section(heading('🎯', t(`Focus for today · ${leftOf}`, `Фокус на сегодня · ${leftOf}`)), focusLines) : focusDone,
    ];
  } else if (a.proposals) {
    sections = [
      `${icon} <b>${proposalsPhrase(a.proposals, base)}</b>`,
      left.length ? section(heading('🎯', t(`Focus for today · ${leftOf}`, `Фокус на сегодня · ${leftOf}`)), focusLines) : focusDone,
    ];
  } else if (left.length) {
    sections = [section(`${icon} <b>${esc(t(`Focus for today: ${leftOf}`, `Фокус на сегодня: ${leftOf}`))}</b>`, focusLines)];
  } else {
    sections = [`✅ <b>${t('Nothing waits for you right now.', 'Сейчас тебя ничего не ждёт.')}</b>`, focusDone];
  }
  return { text: fit([...sections, closedLine]), empty: !waiting && !a.proposals && !left.length };
}

// ── immediate notifications ──
export interface Notice { eventId: number; kind: 'review' | 'blocked'; task: TaskView }

/**
 * Tasks that went to review or got blocked after event `afterId` and are still there: one notice per task.
 * `lastId` is how far the feed was read, whether or not anything is notified.
 */
export async function pendingNotices(q: Queryable, afterId: number, limit = 500): Promise<{ notices: Notice[]; lastId: number }> {
  const { rows } = await q.query(
    `SELECT id, task_id, type FROM task_events WHERE id > $1 ORDER BY id LIMIT $2`, [afterId, limit],
  );
  const lastId = rows.length ? rows[rows.length - 1].id : afterId;
  const wanted = new Map<string, { eventId: number; kind: 'review' | 'blocked' }>();
  for (const r of rows) {
    if (r.type === 'sent_to_review') wanted.set(r.task_id, { eventId: r.id, kind: 'review' });
    else if (r.type === 'blocked') wanted.set(r.task_id, { eventId: r.id, kind: 'blocked' });
  }
  if (!wanted.size) return { notices: [], lastId };
  const tasks = (await q.query(`${TASK_VIEW_SELECT} WHERE t.id = ANY($1) AND t.deleted_at IS NULL`, [[...wanted.keys()]])).rows.map(mapTaskView);
  const notices = tasks
    .map((task) => ({ ...wanted.get(task.id)!, task }))
    .filter((n) => n.task.status === n.kind)
    .sort((x, y) => x.eventId - y.eventId);
  return { notices, lastId };
}

export async function markNotified(q: Queryable, lastId: number): Promise<void> {
  await q.query('UPDATE owner_settings SET notified_event_id = GREATEST(notified_event_id, $1) WHERE id = 1', [lastId]);
}

export async function notifiedUpTo(q: Queryable): Promise<number> {
  const { rows } = await q.query('SELECT notified_event_id AS n FROM owner_settings WHERE id = 1');
  return Number(rows[0].n);
}

/** One task that needs the owner: what it is, where it is from, and the agent's result or the reason it stopped. */
export function renderNotice(n: Notice, base: string | null = null): string {
  const x = n.task;
  const what = n.kind === 'review' ? t('To check', 'Проверь') : t('Blocked', 'Заблокировано');
  const body = n.kind === 'review' ? x.result : x.blockReason;
  return [
    `${n.kind === 'review' ? '👀' : '⛔'} <b>${esc(`${what}: ${truncate(x.title, 160)}`)}</b>`,
    [taskLink(x, base), esc(x.projectName), x.holder ? esc(x.holder.agentName) : ''].filter(Boolean).join(' · '),
    ...(body ? [quote(esc(truncate(body, n.kind === 'review' ? 900 : 500)))] : []),
  ].join('\n');
}

/** Many notices at once, as one message. */
export function renderNoticeBurst(notices: Notice[], base: string | null = null): string {
  const of = (kind: Notice['kind']) => notices.filter((n) => n.kind === kind).map((n) => n.task);
  const review = of('review');
  const blocked = of('blocked');
  return fit([
    `🔔 <b>${esc(tasksWait(notices.length))}</b>`,
    review.length ? listed(heading('👀', t('To check', 'Проверить'), review.length), review, review.length, (x) => item(x, base), 10) : '',
    blocked.length ? listed(heading('⛔', t('Blocked', 'Заблокировано'), blocked.length), blocked, blocked.length, (x) => blockedItem(x, base), 10) : '',
  ]);
}

// ── the review ──
const RANK: Record<Priority, number> = { low: 0, normal: 1, high: 2, urgent: 3 };
const FINDING: Record<ReviewFinding['kind'], string> = { risk: '⚠️', duplicate: '♻️', stale: '⏳', unclear: '❓' };
const CHANGES = 10;

/**
 * The manager's review as messages (one, unless it is very long): the summary, the focus for today, the priorities it
 * changed or suggests, and its notes.
 */
export async function renderReview(q: Queryable, r: ManagerReview, base: string | null): Promise<string[]> {
  const ids = new Map<string, string>();
  const refs = [...new Set(r.findings.flatMap((f) => f.refs))];
  if (base && refs.length) {
    const { rows } = await q.query(
      `SELECT t.id, (p.key || '-' || t.number) AS ref FROM tasks t JOIN projects p ON p.id = t.project_id WHERE (p.key || '-' || t.number) = ANY($1)`, [refs],
    );
    for (const x of rows) ids.set(x.ref, x.id);
  }
  const ref = (s: string) => (ids.has(s) ? taskLink({ id: ids.get(s)!, ref: s }, base) : `<b>${esc(s)}</b>`);

  const change = (c: ReviewChange) =>
    `${RANK[c.to] > RANK[c.from] ? '⬆️' : '⬇️'} ${taskLink({ id: c.taskId, ref: c.ref }, base)} ${esc(truncate(c.title, 70))}\n`
    + `    ${priorityName(c.from)} → <b>${priorityName(c.to)}</b>${c.reason ? ` — ${esc(truncate(c.reason, 160))}` : ''}`;
  const changes = (head: string, all: ReviewChange[]) => {
    if (!all.length) return '';
    const hidden = all.length - CHANGES;
    const body = [...all.slice(0, CHANGES).map(change), ...(hidden > 0 ? [t(`…and ${hidden} more`, `…и ещё ${hidden}`)] : [])].join('\n');
    // a long list folds: the reader opens it when the details matter
    return `${head}\n${all.length > 3 ? `<blockquote expandable>${body}</blockquote>` : body}`;
  };
  const applied = r.changes.filter((c) => c.applied);
  const suggested = r.changes.filter((c) => !c.applied);

  const title = `🧭 <b>${t('Project review', 'Ревизия проектов')}</b>`;
  const summary = r.summary && r.summary !== '—' ? quote(esc(r.summary)) : esc(t('There are no open tasks.', 'Открытых задач нет.'));
  return pack([
    `${title}\n${summary}`,
    focusSection(r.focus, base),
    changes(heading('⚖️', t('Changed priorities', 'Изменил приоритеты'), applied.length), applied),
    changes(heading('💡', t('Suggested priorities', 'Предлагаю изменить приоритеты'), suggested.length), suggested),
    r.findings.length ? section(heading('📝', t('Notes', 'Заметки'), r.findings.length), r.findings.map((f) =>
      `${FINDING[f.kind] ?? '•'} ${f.refs.length ? `${f.refs.map(ref).join(', ')} — ` : ''}${esc(truncate(f.note, 300))}`)) : '',
  ]);
}
