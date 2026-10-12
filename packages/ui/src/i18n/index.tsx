import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { readStored, writeStored } from '../storage';
import { en, type Messages } from './en';
import { ru } from './ru';

export type { Messages };
export { enPlural, ruPlural } from './plural';

export type Lang = 'en' | 'ru';
export const LANGS: readonly Lang[] = ['en', 'ru'];
/** Each language named in itself, as language pickers do. */
export const LANG_NAMES: Record<Lang, string> = { en: 'English', ru: 'Русский' };
export const MESSAGES: Record<Lang, Messages> = { en, ru };
const KEY = 'conus.lang';

const isLang = (v: unknown): v is Lang => v === 'en' || v === 'ru';

/** The language the user picked by hand, or null. */
export function storedLang(): Lang | null {
  const v = readStored(KEY);
  return isLang(v) ? v : null;
}

/** English for everyone until the person picks another language (the choice is remembered in `conus.lang`). */
export const detectLang = (): Lang => storedLang() ?? 'en';

interface I18n {
  /** The dictionary of the current language. */
  t: Messages;
  lang: Lang;
  /** Switches the UI language and remembers it in `conus.lang`. */
  setLang: (lang: Lang) => void;
}

const Ctx = createContext<I18n | null>(null);

/** Holds the UI language for the app and keeps `<html lang>` in step with it. */
export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setState] = useState<Lang>(detectLang);
  const setLang = useCallback((next: Lang) => {
    setState(next);
    writeStored(KEY, next);
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const value = useMemo(() => ({ t: MESSAGES[lang], lang, setLang }), [lang, setLang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const rememberOnly = (next: Lang) => writeStored(KEY, next);

/**
 * The current dictionary, language and setter. Outside a provider (a component rendered on its own in a test) it
 * follows the detected language, and the setter only remembers the choice.
 */
export function useT(): I18n {
  const ctx = useContext(Ctx);
  if (ctx) return ctx;
  const lang = detectLang();
  return { t: MESSAGES[lang], lang, setLang: rememberOnly };
}
