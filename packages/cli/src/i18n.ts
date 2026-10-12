export type Lang = 'en' | 'ru';

/**
 * English for everyone; Russian only by choice: CONUS_LANG=ru, or `conus config set lang ru` (`configured`).
 * The system locale does not decide.
 */
export function detectLang(env: NodeJS.ProcessEnv, configured?: string | null): Lang {
  const choice = env.CONUS_LANG || configured || '';
  return /^ru\b|^ru[_-]/i.test(choice.trim()) ? 'ru' : 'en';
}

/** Picks the message for the user's language: `t('Logged in', 'Вход выполнен')`. */
export type Translate = (en: string, ru: string) => string;

export const translator = (lang: Lang): Translate => (en, ru) => (lang === 'ru' ? ru : en);
