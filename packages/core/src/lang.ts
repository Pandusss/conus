/**
 * The language of the text the server writes for people: chat notes, the status line, Stop-hook nudges, task
 * history entries and the judge's summaries. One owner, one language: set once at startup from CONUS_LANG.
 */
export type Lang = 'en' | 'ru';

let current: Lang = 'en';

export function parseLang(raw: string | undefined): Lang {
  return raw?.trim().toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

export function setLang(lang: Lang): void { current = lang; }
export function getLang(): Lang { return current; }

/** The text in the server's language: `t('in progress', 'в работе')`. */
export const t = (en: string, ru: string): string => (current === 'ru' ? ru : en);

/** The word for a number: `plural(3, ['task', 'tasks'], ['задача', 'задачи', 'задач'])` → «задачи». */
export function plural(n: number, en: readonly [string, string], ru: readonly [string, string, string]): string {
  const a = Math.abs(n);
  if (current !== 'ru') return a === 1 ? en[0] : en[1];
  const tens = a % 100; const ones = a % 10;
  if (tens > 10 && tens < 20) return ru[2];
  if (ones === 1) return ru[0];
  return ones >= 2 && ones <= 4 ? ru[1] : ru[2];
}

/** The language's English name, for instructions to the judge model. */
export const langName = (): string => (current === 'ru' ? 'Russian' : 'English');
