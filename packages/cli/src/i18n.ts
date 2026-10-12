export type Lang = 'en' | 'ru';

/** The language of the user's messages: Russian when the locale says so, English otherwise. */
export function detectLang(env: NodeJS.ProcessEnv): Lang {
  const locale = env.CONUS_LANG || env.LC_ALL || env.LC_MESSAGES || env.LANG || safeIntlLocale();
  return /^ru\b|^ru[_-]/i.test(locale) ? 'ru' : 'en';
}

function safeIntlLocale(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().locale; } catch { return ''; }
}

/** Picks the message for the user's language: `t('Logged in', 'Вход выполнен')`. */
export type Translate = (en: string, ru: string) => string;

export const translator = (lang: Lang): Translate => (en, ru) => (lang === 'ru' ? ru : en);
