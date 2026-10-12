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

/** The language's English name, for instructions to the judge model. */
export const langName = (): string => (current === 'ru' ? 'Russian' : 'English');
