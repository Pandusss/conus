import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { detectLang, enPlural, LangProvider, ruPlural, useT } from '.';
import { en } from './en';
import { ru } from './ru';

/** Pretends the browser prefers these languages, most wanted first. */
function browserPrefers(...languages: string[]) {
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(languages);
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(languages[0] ?? '');
}

beforeEach(() => localStorage.removeItem('conus.lang')); // the test setup pins Russian; these tests start from nothing
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.lang = '';
});

describe('detectLang', () => {
  it('is English for every browser, Russian ones included, until the person picks a language', () => {
    for (const prefs of [['ru-RU', 'en-US'], ['ru'], ['en-GB'], ['de'], []]) {
      browserPrefers(...prefs);
      expect(detectLang()).toBe('en');
    }
  });

  it('keeps the stored choice, and ignores a stored value it does not know', () => {
    localStorage.setItem('conus.lang', 'ru');
    expect(detectLang()).toBe('ru');
    localStorage.setItem('conus.lang', 'en');
    expect(detectLang()).toBe('en');
    localStorage.setItem('conus.lang', 'fr');
    expect(detectLang()).toBe('en');
  });

  it('is English when storage is denied', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    expect(detectLang()).toBe('en');
  });
});

describe('plurals', () => {
  it('picks the Russian form by the last digits', () => {
    const tasks = (n: number) => `${n} ${ruPlural(n, 'задача', 'задачи', 'задач')}`;
    expect([0, 1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111, 1004].map(tasks)).toEqual([
      '0 задач', '1 задача', '2 задачи', '4 задачи', '5 задач', '11 задач', '12 задач', '14 задач',
      '21 задача', '22 задачи', '25 задач', '101 задача', '111 задач', '1004 задачи',
    ]);
  });
  it('picks the English form', () => {
    expect([0, 1, 2].map((n) => enPlural(n, 'day', 'days'))).toEqual(['days', 'day', 'days']);
  });
});

describe('dictionaries', () => {
  /** Every leaf path with the kind of its value (string or function). */
  const shape = (o: object, prefix = ''): string[] => Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === 'object' ? shape(v as object, `${prefix}${k}.`) : [`${prefix}${k}:${typeof v}`]);

  it('have the same keys, with a function wherever English has one', () => {
    expect(shape(ru)).toEqual(shape(en));
  });
  it('carry their locale for dates', () => {
    expect(en.locale).toBe('en-US');
    expect(ru.locale).toBe('ru-RU');
  });
});

function Probe() {
  const { t, lang, setLang } = useT();
  return (
    <>
      <p data-testid="lang">{lang}</p>
      <p>{t.shell.board}</p>
      <button type="button" onClick={() => setLang(lang === 'en' ? 'ru' : 'en')}>switch</button>
    </>
  );
}

describe('LangProvider', () => {
  it('starts in English even in a Russian browser, from a stored choice otherwise, and keeps <html lang> in step', () => {
    browserPrefers('ru-RU');
    const first = render(<LangProvider><Probe /></LangProvider>);
    expect(screen.getByText('Board')).toBeTruthy();
    expect(document.documentElement.lang).toBe('en');
    first.unmount();
    localStorage.setItem('conus.lang', 'ru');
    render(<LangProvider><Probe /></LangProvider>);
    expect(screen.getByText('Доска')).toBeTruthy();
    expect(document.documentElement.lang).toBe('ru');
  });

  it('switches the language, remembers it and updates <html lang>', async () => {
    browserPrefers('en-US');
    render(<LangProvider><Probe /></LangProvider>);
    expect(screen.getByText('Board')).toBeTruthy();
    expect(document.documentElement.lang).toBe('en');
    await userEvent.click(screen.getByRole('button', { name: 'switch' }));
    expect(screen.getByText('Доска')).toBeTruthy();
    expect(localStorage.getItem('conus.lang')).toBe('ru');
    expect(document.documentElement.lang).toBe('ru');
  });

  it('works without a provider, following the stored choice', () => {
    localStorage.setItem('conus.lang', 'ru');
    render(<Probe />);
    expect(screen.getByTestId('lang').textContent).toBe('ru');
    expect(screen.getByText('Доска')).toBeTruthy();
  });
});
