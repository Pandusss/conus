import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Queryable } from './db';
import { DomainError } from './errors';

/** The owner's schedule and Telegram link. One row (id = 1), created by migration 0003. */
export interface OwnerSettings {
  timeZone: string;
  /** 'HH:MM' in the owner's time zone: the morning digest and the manager's daily review. */
  digestTime: string;
  /** Immediate notifications wait outside these hours ('HH:MM'–'HH:MM', may cross midnight). */
  quietFrom: string; quietTo: string;
  notifyReview: boolean; notifyBlocked: boolean;
  /** The daily review may change priorities by itself (never ones the owner set). */
  managerAuto: boolean;
  telegramChatId: number | null; telegramUsername: string | null;
  lastDigestOn: string | null; lastReviewOn: string | null;
}

export type SettingsPatch = Partial<Pick<OwnerSettings, 'timeZone' | 'digestTime' | 'quietFrom' | 'quietTo' | 'notifyReview' | 'notifyBlocked' | 'managerAuto'>>;

const map = (r: any): OwnerSettings => ({
  timeZone: r.time_zone, digestTime: r.digest_time, quietFrom: r.quiet_from, quietTo: r.quiet_to,
  notifyReview: r.notify_review, notifyBlocked: r.notify_blocked, managerAuto: r.manager_auto,
  telegramChatId: r.telegram_chat_id == null ? null : Number(r.telegram_chat_id), telegramUsername: r.telegram_username,
  lastDigestOn: r.last_digest_on, lastReviewOn: r.last_review_on,
});

export async function getSettings(q: Queryable): Promise<OwnerSettings> {
  const { rows } = await q.query('SELECT * FROM owner_settings WHERE id = 1');
  return map(rows[0]);
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function updateSettings(q: Queryable, patch: SettingsPatch): Promise<OwnerSettings> {
  if (patch.timeZone !== undefined && !isTimeZone(patch.timeZone)) {
    throw new DomainError('validation', 'Unknown time zone.', { field: 'time_zone' });
  }
  for (const k of ['digestTime', 'quietFrom', 'quietTo'] as const) {
    if (patch[k] !== undefined && !TIME_RE.test(patch[k]!)) throw new DomainError('validation', `${k} must be HH:MM.`, { field: k });
  }
  const { rows } = await q.query(
    `UPDATE owner_settings SET
       time_zone = COALESCE($1, time_zone), digest_time = COALESCE($2, digest_time),
       quiet_from = COALESCE($3, quiet_from), quiet_to = COALESCE($4, quiet_to),
       notify_review = COALESCE($5, notify_review), notify_blocked = COALESCE($6, notify_blocked),
       manager_auto = COALESCE($7, manager_auto), updated_at = now()
     WHERE id = 1 RETURNING *`,
    [patch.timeZone ?? null, patch.digestTime ?? null, patch.quietFrom ?? null, patch.quietTo ?? null,
      patch.notifyReview ?? null, patch.notifyBlocked ?? null, patch.managerAuto ?? null],
  );
  return map(rows[0]);
}

/** Pieces of the wall clock in a time zone: the date 'YYYY-MM-DD' and the time 'HH:MM'. */
export function localClock(now: Date, timeZone: string): { date: string; time: string; weekday: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(now).map((p) => [p.type, p.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday!);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, weekday };
}

/** Whether 'HH:MM' falls in [from, to); the range may cross midnight (22:00–08:00). Equal ends mean never. */
export function inQuietHours(time: string, from: string, to: string): boolean {
  if (from === to) return false;
  return from < to ? time >= from && time < to : time >= from || time < to;
}

// ── linking a Telegram chat ──
const LINK_TTL_MS = 15 * 60_000;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** A one-time code the owner sends to the bot (/start <code>); 15 minutes; a new code replaces the old one. */
export async function createTelegramLinkCode(q: Queryable, now: Date = new Date()): Promise<{ code: string; expiresAt: Date }> {
  const code = randomBytes(12).toString('base64url');
  const expiresAt = new Date(now.getTime() + LINK_TTL_MS);
  await q.query('UPDATE owner_settings SET telegram_link_hash = $1, telegram_link_expires_at = $2, updated_at = now() WHERE id = 1', [sha(code), expiresAt]);
  return { code, expiresAt };
}

/** Binds the chat when the code matches and has not expired; the code works once. */
export async function linkTelegramChat(
  q: Queryable, input: { code: string; chatId: number; username: string | null }, now: Date = new Date(),
): Promise<boolean> {
  const { rows } = await q.query('SELECT telegram_link_hash AS h, telegram_link_expires_at AS exp FROM owner_settings WHERE id = 1');
  const r = rows[0];
  if (!r?.h || !r.exp || new Date(r.exp).getTime() < now.getTime()) return false;
  const given = Buffer.from(sha(input.code.trim()));
  const stored = Buffer.from(r.h as string);
  if (given.length !== stored.length || !timingSafeEqual(given, stored)) return false;
  await q.query(
    `UPDATE owner_settings SET telegram_chat_id = $1, telegram_username = $2, telegram_link_hash = NULL,
       telegram_link_expires_at = NULL, updated_at = now() WHERE id = 1`,
    [input.chatId, input.username],
  );
  return true;
}

export async function unlinkTelegram(q: Queryable): Promise<void> {
  await q.query(`UPDATE owner_settings SET telegram_chat_id = NULL, telegram_username = NULL, telegram_link_hash = NULL,
                   telegram_link_expires_at = NULL, updated_at = now() WHERE id = 1`);
}
