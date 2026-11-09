import type { Priority, Status } from './api';
import type { Messages } from './i18n';

export const STATUSES: readonly Status[] = ['proposed', 'todo', 'in_progress', 'blocked', 'review', 'done', 'dropped'];

/** Statuses a task can be moved to by hand, in board order. */
export const MOVABLE_STATUSES: Status[] = ['todo', 'in_progress', 'blocked', 'review', 'done', 'dropped'];

/** Moving a task to these asks for a reason first. */
export const needsReason = (s: Status): boolean => s === 'blocked' || s === 'dropped';

/** Most urgent first. */
export const PRIORITIES: readonly Priority[] = ['urgent', 'high', 'normal', 'low'];
export const priorityRank = (p: Priority | undefined): number => { const i = PRIORITIES.indexOf(p ?? 'normal'); return i < 0 ? 2 : i; };
export const isPriority = (p: unknown): p is Priority => typeof p === 'string' && (PRIORITIES as readonly string[]).includes(p);

/** Today in the browser's time zone, as 'YYYY-MM-DD'. */
export function localToday(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** Whole days from today to a 'YYYY-MM-DD' date: negative is overdue, 0 is today. */
export function daysUntil(dueOn: string, now: Date = new Date()): number {
  const day = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y!, m! - 1, d!); };
  return Math.round((day(dueOn) - day(localToday(now))) / 86_400_000);
}

export type DueState = 'overdue' | 'today' | 'soon' | 'later';
/** A 'YYYY-MM-DD' day in full: «12 November 2026». */
export function formatDay(dueOn: string, t: Messages): string {
  const [y, m, d] = dueOn.split('-').map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString(t.locale, { day: 'numeric', month: 'long', year: 'numeric' });
}

/** How pressing a due date is: past, today, within 3 days, or later. */
export function dueState(dueOn: string, now: Date = new Date()): DueState {
  const d = daysUntil(dueOn, now);
  return d < 0 ? 'overdue' : d === 0 ? 'today' : d <= 3 ? 'soon' : 'later';
}

/** «Overdue 2 d», «Today», «Tomorrow», «In 3 d», or the date itself further out. */
export function dueLabel(dueOn: string, t: Messages, now: Date = new Date()): string {
  const d = daysUntil(dueOn, now);
  if (d < 0) return t.due.overdue(-d);
  if (d === 0) return t.due.today;
  if (d === 1) return t.due.tomorrow;
  if (d <= 6) return t.due.inDays(d);
  const [y, m, day] = dueOn.split('-').map(Number);
  const date = new Date(y!, m! - 1, day!);
  return date.toLocaleDateString(t.locale, { day: 'numeric', month: 'short', ...(y !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

export const isStatus = (s: unknown): s is Status => typeof s === 'string' && (STATUSES as readonly string[]).includes(s);

/** A dictionary entry for a code the server sends; codes we do not know (or inherited keys) give undefined. */
function lookup(map: object, code: string): string | undefined {
  return Object.hasOwn(map, code) ? (map as Record<string, string>)[code] : undefined;
}

/** The name of a status code; unknown values are shown as they are, null/undefined as a dash. */
export function statusLabel(s: unknown, t: Messages): string {
  if (s === null || s === undefined) return '—';
  return isStatus(s) ? t.status[s] : String(s);
}

export const eventLabel = (type: string, t: Messages): string => lookup(t.event, type) ?? type;
export const kindLabel = (kind: string, t: Messages): string => lookup(t.kind, kind) ?? kind;
export const ruleLabel = (rule: string, t: Messages): string => lookup(t.rule, rule) ?? rule;
export const sessionStateLabel = (state: string, t: Messages): string => lookup(t.sessionState, state) ?? state;

export function formatTime(iso: string, t: Messages): string {
  return new Date(iso).toLocaleString(t.locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function formatDate(iso: string, t: Messages): string {
  return new Date(iso).toLocaleString(t.locale, { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** «just now», «5 min ago», «3 h ago», «yesterday», «4 d ago», then a short date. Future times count as now. */
export function relativeTime(iso: string, t: Messages, now: number = Date.now()): string {
  const min = Math.floor(Math.max(0, now - new Date(iso).getTime()) / 60_000);
  if (min < 1) return t.time.justNow;
  if (min < 60) return t.time.minutesAgo(min);
  const h = Math.floor(min / 60);
  if (h < 24) return t.time.hoursAgo(h);
  const d = Math.floor(h / 24);
  if (d === 1) return t.time.yesterday;
  if (d < 7) return t.time.daysAgo(d);
  return new Date(iso).toLocaleDateString(t.locale, { day: 'numeric', month: 'short' });
}

/** A compact duration: «<1 min», «42 min», «2 h 5 min», «3 d 4 h». */
export function formatDuration(ms: number, t: Messages): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return t.duration.underMinute;
  if (min < 60) return t.duration.minutes(min);
  const h = Math.floor(min / 60);
  if (h < 24) return t.duration.hours(h, min % 60);
  return t.duration.days(Math.floor(h / 24), h % 24);
}

/** Two letters for an avatar: «claude-code@laptop» → «CC», «вы» → «ВЫ». */
export function initials(name: string): string {
  const parts = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!parts.length) return '?';
  const letters = parts.length > 1 ? parts[0]![0]! + parts[1]![0]! : parts[0]!.slice(0, 2);
  return letters.toUpperCase();
}
