import type { Status } from './api';
import type { Messages } from './i18n';

export const STATUSES: readonly Status[] = ['proposed', 'todo', 'in_progress', 'blocked', 'review', 'done', 'dropped'];

/** Statuses a task can be moved to by hand, in board order. */
export const MOVABLE_STATUSES: Status[] = ['todo', 'in_progress', 'blocked', 'review', 'done', 'dropped'];

/** Moving a task to these asks for a reason first. */
export const needsReason = (s: Status): boolean => s === 'blocked' || s === 'dropped';

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
