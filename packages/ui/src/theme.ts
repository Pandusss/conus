import { useCallback, useEffect, useState } from 'react';
import { readStored, writeStored } from './storage';

export type Theme = 'light' | 'dark';
const KEY = 'conus.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

/** The theme the user picked by hand, or null to follow the system. */
export function storedTheme(): Theme | null {
  const v = readStored(KEY);
  return v === 'light' || v === 'dark' ? v : null;
}

const systemDark = (): boolean => {
  try { return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches; } catch { return false; }
};

/** Pins the page to a theme (`data-theme` on <html>), or lets the CSS media query follow the system. */
export function applyTheme(theme: Theme | null): void {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

/** The effective theme and a toggle that pins the opposite one and remembers it. */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [picked, setPicked] = useState<Theme | null>(storedTheme);
  const [dark, setDark] = useState(systemDark);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(DARK_QUERY);
    const onChange = () => setDark(mq.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  const theme: Theme = picked ?? (dark ? 'dark' : 'light');
  const toggle = useCallback(() => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setPicked(next);
    writeStored(KEY, next);
    applyTheme(next);
  }, [theme]);
  return { theme, toggle };
}
