import { plural, t } from '../lang';
import { truncate } from '../text';
import type { Priority } from '../types';

/**
 * How the manager writes to Telegram. A message is a list of sections (a heading with its lines), each one balanced
 * HTML, joined by a blank line: a message that is too long loses whole sections, never half a tag.
 */

/** Telegram allows 4096 characters, counted after the markup is parsed; some room is left. */
export const TELEGRAM_MAX = 4000;
/** A message keeps about a hundred formatted pieces; the ones over that lose their formatting. */
const ENTITY_MAX = 90;
const DAY = 86_400_000;

/** Telegram HTML: only &, < and > need escaping. */
export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (s: string) => esc(s).replace(/"/g, '&quot;');
/** What the reader sees: no tags, entities decoded. */
export const plainText = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
export const visibleLength = (html: string) => plainText(html).length;
const fits = (html: string, max: number) => visibleLength(html) <= max && (html.match(/<[a-z][^>]*>/g) ?? []).length <= ENTITY_MAX;

/** The web app's address for links, or null when a link would not open from Telegram (not https, or a local address). */
export function linkBase(publicUrl: string | null | undefined): string | null {
  if (!publicUrl || !/^https:\/\//.test(publicUrl) || /^https:\/\/(localhost|127\.|\[::1\])/.test(publicUrl)) return null;
  return publicUrl.replace(/\/+$/, '');
}

export const link = (href: string, html: string) => `<a href="${attr(href)}">${html}</a>`;
/** The task's ref: a link to the task when the web app is reachable, bold otherwise. */
export const taskLink = (x: { id: string; ref: string }, base: string | null) =>
  (base ? link(`${base}/tasks/${x.id}`, esc(x.ref)) : `<b>${esc(x.ref)}</b>`);

/** «👀 <b>To check · 3</b>» */
export const heading = (emoji: string, title: string, count?: number) => `${emoji} <b>${esc(title)}${count == null ? '' : ` · ${count}`}</b>`;
/** A heading with its lines, and «…and 2 more» for what is not listed. */
export function section(head: string, lines: string[], hidden = 0): string {
  return [head, ...lines, ...(hidden > 0 ? [t(`…and ${hidden} more`, `…и ещё ${hidden}`)] : [])].join('\n');
}
/** The second line of a list item: a reason, a note. */
export const under = (text: string) => `    <i>${esc(text)}</i>`;

/** A quote block; a long one folds, and opens on a tap. */
export function quote(html: string): string {
  const long = visibleLength(html) > 320 || html.split('\n').length > 5;
  return `<blockquote${long ? ' expandable' : ''}>${html}</blockquote>`;
}

/** One message from sections: what does not fit is dropped from the end, so the most important goes first.
 * `kept` is how many sections made it (0 when even the first one had to be cut down to plain text). */
export function fitted(sections: string[], max = TELEGRAM_MAX): { text: string; kept: number } {
  const out = sections.filter(Boolean);
  const all = out.length;
  const text = () => [...out, ...(out.length < all ? ['…'] : [])].join('\n\n');
  while (out.length > 1 && !fits(text(), max)) out.pop();
  return fits(text(), max) ? { text: text(), kept: out.length } : { text: esc(truncate(plainText(text()), max)), kept: 0 };
}
export const fit = (sections: string[], max = TELEGRAM_MAX): string => fitted(sections, max).text;

/** Several messages from sections, when one cannot hold them all. */
export function pack(sections: string[], max = TELEGRAM_MAX): string[] {
  const out: string[] = [];
  let current = '';
  for (const s of sections.filter(Boolean)) {
    const next = current ? `${current}\n\n${s}` : s;
    if (fits(next, max)) { current = next; continue; }
    if (current) out.push(current);
    current = fits(s, max) ? s : esc(truncate(plainText(s), max));
  }
  if (current) out.push(current);
  return out;
}

// ── words ──
export const dayDiff = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
const days = (n: number) => `${n} ${plural(n, ['day', 'days'], ['день', 'дня', 'дней'])}`;

/** «overdue by 2 days» / «due today» / «due tomorrow» / «due in 5 days», relative to the owner's today. */
export function dueWords(dueOn: string, today: string): string {
  const d = dayDiff(today, dueOn);
  if (d < 0) return t(`overdue by ${days(-d)}`, `просрочено на ${days(-d)}`);
  if (d === 0) return t('due today', 'срок сегодня');
  if (d === 1) return t('due tomorrow', 'срок завтра');
  return t(`due in ${days(d)}`, `срок через ${days(d)}`);
}

/** «waiting 5 h» / «waiting 2 days»; nothing during the first hour. */
export function waitedWords(since: Date, now: Date): string {
  const hours = Math.floor((now.getTime() - since.getTime()) / 3_600_000);
  if (hours < 1) return '';
  if (hours < 24) return t(`waiting ${hours} h`, `ждёт ${hours} ч`);
  return t(`waiting ${days(Math.floor(hours / 24))}`, `ждёт ${days(Math.floor(hours / 24))}`);
}

export const priorityName = (p: Priority): string =>
  ({ urgent: t('Urgent', 'Срочно'), high: t('High', 'Высокий'), normal: t('Normal', 'Обычный'), low: t('Low', 'Низкий') })[p];

const localDate = (day: string, options: Intl.DateTimeFormatOptions) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString(t('en-US', 'ru-RU'), { ...options, timeZone: 'UTC' });
};
/** '2026-11-12' → «Nov 12» / «12 нояб.» */
export const shortDate = (day: string) => localDate(day, { day: 'numeric', month: 'short' });
/** '2026-11-09' → «Monday, November 9» / «понедельник, 9 ноября» */
export const longDate = (day: string) => localDate(day, { weekday: 'long', day: 'numeric', month: 'long' });
