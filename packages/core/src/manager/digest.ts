import type { Queryable } from '../db';
import { t } from '../lang';
import { getOverview, type OverviewTask } from '../overview';
import { getSettings, localClock } from '../settings';
import { TASK_VIEW_SELECT, mapTaskView } from '../tasks/queries';
import { truncate } from '../text';
import type { TaskView } from '../types';
import { latestReview } from './review';

/** Telegram HTML: only &, < and > need escaping. */
export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const TELEGRAM_MAX = 4000;
const LIST = 5;
const DAY = 86_400_000;

const dayDiff = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

/** «overdue 2 d» / «today» / «tomorrow» / «in 5 d» relative to the owner's today. */
export function dueWords(dueOn: string, today: string): string {
  const d = dayDiff(today, dueOn);
  if (d < 0) return t(`overdue ${-d} d`, `просрочено на ${-d} дн`);
  if (d === 0) return t('due today', 'срок сегодня');
  if (d === 1) return t('due tomorrow', 'срок завтра');
  return t(`due in ${d} d`, `срок через ${d} дн`);
}

const line = (x: Pick<TaskView, 'ref' | 'title'>, extra?: string) => `• <b>${esc(x.ref)}</b> ${esc(truncate(x.title, 90))}${extra ? ` — ${esc(extra)}` : ''}`;
const more = (n: number) => (n > 0 ? [t(`  …and ${n} more`, `  …и ещё ${n}`)] : []);

/** Fits a message into Telegram's limit by dropping whole lines from the end. */
export function fit(lines: string[], max = TELEGRAM_MAX): string {
  const out = [...lines];
  while (out.join('\n').length > max && out.length > 1) out.splice(out.length - 2, 1);
  return out.join('\n');
}

/**
 * The morning digest: the manager's focus for today, what waits for the owner (checks, blockers, deadlines,
 * proposals), work in progress and yesterday's results, then one line per project.
 */
export async function buildDigest(q: Queryable, publicUrl: string | null, now: Date = new Date()): Promise<string> {
  const settings = await getSettings(q);
  const today = localClock(now, settings.timeZone).date;
  const o = await getOverview(q, now);
  const review = await latestReview(q);
  const freshReview = review && now.getTime() - review.createdAt.getTime() < 20 * 3_600_000 ? review : null;
  const doneRows = await q.query(`${TASK_VIEW_SELECT} WHERE t.status = 'done' AND t.deleted_at IS NULL AND t.closed_at > $1 ORDER BY t.closed_at DESC`,
    [new Date(now.getTime() - DAY)]);
  const done = doneRows.rows.map(mapTaskView);
  const working = o.projects.flatMap((p) => p.inProgress);

  const [y, m, d] = today.split('-').map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString(t('en-US', 'ru-RU'), { day: 'numeric', month: 'long', timeZone: 'UTC' });
  const out: string[] = [`☀️ <b>${esc(t(`Conus · ${date}`, `Conus · ${date}`))}</b>`];
  if (freshReview?.summary && freshReview.summary !== '—') out.push('', esc(freshReview.summary));

  if (freshReview?.focus.length) {
    out.push('', `🎯 <b>${t('Focus for today', 'Фокус на сегодня')}</b>`);
    freshReview.focus.forEach((f, i) => out.push(`${i + 1}. <b>${esc(f.ref)}</b> ${esc(truncate(f.title, 80))}\n    <i>${esc(f.why)}</i>`));
  }

  const a = o.attention;
  const dated = a.dated.filter((x) => x.dueOn && dayDiff(today, x.dueOn) <= 1);
  if (a.review.length || a.blocked.length || dated.length || a.proposals) {
    out.push('', `👀 <b>${t('Waiting for you', 'Ждёт тебя')}</b>`);
    if (a.review.length) {
      out.push(t(`To check (${a.review.length}):`, `Проверить (${a.review.length}):`));
      a.review.slice(0, LIST).forEach((x) => out.push(line(x, waited(x, now))));
      out.push(...more(a.review.length - LIST));
    }
    if (a.blocked.length) {
      out.push(t(`Blocked (${a.blocked.length}):`, `Заблокировано (${a.blocked.length}):`));
      a.blocked.slice(0, LIST).forEach((x) => out.push(line(x, truncate(x.blockReason ?? '', 120))));
      out.push(...more(a.blocked.length - LIST));
    }
    if (dated.length) {
      out.push(t('Deadlines:', 'Сроки:'));
      dated.slice(0, LIST).forEach((x) => out.push(line(x, dueWords(x.dueOn!, today))));
      out.push(...more(dated.length - LIST));
    }
    if (a.proposals) out.push(t(`Proposals to look at: ${a.proposals}`, `Предложений на разбор: ${a.proposals}`));
  } else {
    out.push('', t('✅ Nothing waits for you.', '✅ Тебя ничего не ждёт.'));
  }

  if (working.length) {
    out.push('', `🛠 <b>${t('In progress', 'В работе')}</b>`);
    working.slice(0, LIST).forEach((x) => out.push(line(x, x.holder?.agentName)));
    out.push(...more(working.length - LIST));
  }
  if (done.length) {
    out.push('', `✅ <b>${t(`Done in the last 24 h: ${done.length}`, `Готово за сутки: ${done.length}`)}</b>`);
    done.slice(0, LIST).forEach((x) => out.push(line(x)));
    out.push(...more(done.length - LIST));
  }

  const active = o.projects.filter((p) => !p.quiet);
  if (active.length) {
    out.push('', `📊 <b>${t('Projects', 'Проекты')}</b>`);
    for (const p of active) {
      const c = p.counts;
      const parts = [
        c.in_progress && t(`${c.in_progress} in progress`, `${c.in_progress} в работе`),
        c.review && t(`${c.review} to check`, `${c.review} на проверке`),
        c.blocked && t(`${c.blocked} blocked`, `${c.blocked} заблок.`),
        c.todo && t(`${c.todo} to do`, `${c.todo} к выполнению`),
      ].filter(Boolean);
      out.push(`• <b>${esc(p.key)}</b> ${esc(truncate(p.name, 40))}: ${parts.length ? parts.join(', ') : t('nothing open', 'открытых нет')}`);
    }
  }
  if (publicUrl) out.push('', `<a href="${esc(publicUrl)}">${t('Open Conus', 'Открыть Conus')}</a>`);
  return fit(out);
}

const waited = (x: OverviewTask, now: Date) => {
  const days = Math.floor((now.getTime() - x.updatedAt.getTime()) / DAY);
  return days >= 1 ? t(`waiting ${days} d`, `ждёт ${days} дн`) : '';
};

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

export function renderNotice(n: Notice): string {
  const x = n.task;
  const head = n.kind === 'review'
    ? `👀 <b>${esc(x.ref)}</b> ${t('is waiting for your check', 'ждёт проверки')} · ${esc(x.projectName)}`
    : `⛔ <b>${esc(x.ref)}</b> ${t('is blocked', 'заблокирована')} · ${esc(x.projectName)}`;
  const body = n.kind === 'review'
    ? (x.result ? `\n\n<i>${esc(truncate(x.result, 700))}</i>` : '')
    : (x.blockReason ? `\n${t('Reason', 'Причина')}: ${esc(truncate(x.blockReason, 400))}` : '');
  return `${head}\n${esc(truncate(x.title, 200))}${body}`;
}
