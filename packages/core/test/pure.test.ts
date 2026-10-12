import { describe, expect, it } from 'vitest';
import { parseTaskRef, formatRef } from '../src/refs';
import { chatNote, shortTitle } from '../src/chat-note';
import { assertTransition, isOpen, TRANSITIONS } from '../src/state-machine';
import { DomainError } from '../src/errors';
import { STATUSES } from '../src/types';
import { parseLang, setLang } from '../src/lang';

describe('refs', () => {
  it('parses key-number, bare number and #number', () => {
    expect(parseTaskRef('WB-42')).toEqual({ key: 'WB', number: 42 });
    expect(parseTaskRef(' wb-7 ')).toEqual({ key: 'WB', number: 7 });
    expect(parseTaskRef('42')).toEqual({ key: null, number: 42 });
    expect(parseTaskRef('#42')).toEqual({ key: null, number: 42 });
    expect(parseTaskRef('AT2-3')).toEqual({ key: 'AT2', number: 3 });
  });
  it('rejects garbage with a validation error', () => {
    expect(() => parseTaskRef('task 42')).toThrowError(DomainError);
    try { parseTaskRef(''); } catch (e) { expect((e as DomainError).code).toBe('validation'); }
  });
  it('formats', () => expect(formatRef('WB', 42)).toBe('WB-42'));
});

describe('chat notes', () => {
  const t = { ref: 'WB-42', title: 'Добавить импорт CSV' };
  it.each([
    ['created', '+WB-42 Добавить импорт CSV', '+WB-42 Добавить импорт CSV'],
    ['created_started', '+WB-42 Добавить импорт CSV → in progress', '+WB-42 Добавить импорт CSV → в работе'],
    ['proposed', '?WB-42 Добавить импорт CSV', '?WB-42 Добавить импорт CSV'],
    ['started', 'WB-42 → in progress', 'WB-42 → в работе'],
    ['blocked', 'WB-42 → blocked', 'WB-42 → заблокирована'],
    ['completed', 'WB-42 → done', 'WB-42 → готово'],
    ['review', 'WB-42 → review', 'WB-42 → на проверку'],
    ['dropped', 'WB-42 → dropped', 'WB-42 → отменена'],
    ['updated', 'WB-42 updated', 'WB-42 обновлена'],
    ['promoted', 'WB-42 → to do', 'WB-42 → к выполнению'],
    ['reopened', 'WB-42 → reopened', 'WB-42 → открыта снова'],
  ] as const)('%s, in the server language (CONUS_LANG)', (kind, en, ru) => {
    expect(chatNote(kind, t)).toBe(en);
    setLang('ru');
    try { expect(chatNote(kind, t)).toBe(ru); } finally { setLang('en'); }
  });
  it('reads CONUS_LANG: Russian for ru*, English otherwise', () => {
    expect(['ru', 'RU', 'ru_RU.UTF-8', ' ru-ru'].map(parseLang)).toEqual(['ru', 'ru', 'ru', 'ru']);
    expect(['en', '', undefined, 'de'].map(parseLang)).toEqual(['en', 'en', 'en', 'en']);
  });
  it('shortens long titles to 40 chars with ellipsis', () => {
    const s = shortTitle('a'.repeat(60));
    expect(s.length).toBe(40);
    expect(s.endsWith('…')).toBe(true);
  });
});

describe('state machine', () => {
  it('allows listed transitions', () => {
    for (const [cmd, froms] of Object.entries(TRANSITIONS)) {
      for (const from of froms) expect(() => assertTransition(cmd as never, from, 'X-1')).not.toThrow();
    }
  });
  it('rejects everything else with invalid_transition and the current status', () => {
    for (const [cmd, froms] of Object.entries(TRANSITIONS)) {
      for (const from of STATUSES.filter((s) => !froms.includes(s))) {
        try {
          assertTransition(cmd as never, from, 'X-1');
          throw new Error(`expected ${cmd} from ${from} to fail`);
        } catch (e) {
          expect((e as DomainError).code).toBe('invalid_transition');
          expect((e as DomainError).details.current).toBe(from);
        }
      }
    }
  });
  it('knows open statuses', () => {
    expect(isOpen('review')).toBe(true);
    expect(isOpen('done')).toBe(false);
    expect(isOpen('dropped')).toBe(false);
  });
});
