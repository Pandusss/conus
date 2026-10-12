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
  it('picks Russian for a Russian browser', () => {
    browserPrefers('ru-RU', 'en-US');
    expect(detectLang()).toBe('ru');
    browserPrefers('ru');
    expect(detectLang()).toBe('ru');
  });

  it('picks English for any other browser', () => {
    browserPrefers('en-GB');
    expect(detectLang()).toBe('en');
    browserPrefers('de');
    expect(detectLang()).toBe('en');
    browserPrefers('rue'); // Rusyn is not Russian
    expect(detectLang()).toBe('en');
    browserPrefers();
    expect(detectLang()).toBe('en');
  });

  it('takes the first preferred language it has a dictionary for', () => {
    browserPrefers('de-DE', 'RU', 'en');
    expect(detectLang()).toBe('ru');
    browserPrefers('en-US', 'ru-RU');
    expect(detectLang()).toBe('en');
  });

  it('falls back to navigator.language when there is no list', () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue([]);
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('ru-UA');
    expect(detectLang()).toBe('ru');
  });

  it('lets a stored choice win over the browser, and ignores a stored value it does not know', () => {
    browserPrefers('ru-RU');
    localStorage.setItem('conus.lang', 'en');
    expect(detectLang()).toBe('en');
    browserPrefers('en-US');
    localStorage.setItem('conus.lang', 'ru');
    expect(detectLang()).toBe('ru');
    localStorage.setItem('conus.lang', 'fr');
    expect(detectLang()).toBe('en');
  });

  it('follows the browser when storage is denied', () => {
    browserPrefers('ru-RU');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    expect(detectLang()).toBe('ru');
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
  it('starts from the detected language and keeps <html lang> in step', () => {
    browserPrefers('ru-RU');
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
