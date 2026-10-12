import { describe, expect, it } from 'vitest';
import { en } from './i18n/en';
import { ru } from './i18n/ru';
import { eventLabel, formatDuration, formatTime, initials, kindLabel, relativeTime, ruleLabel, sessionStateLabel, statusLabel } from './labels';

describe('labels', () => {
  it('translates statuses, falling back to the raw value or a dash', () => {
    expect(statusLabel('in_progress', ru)).toBe('В работе');
    expect(statusLabel('in_progress', en)).toBe('In progress');
    expect(statusLabel(null, ru)).toBe('—');
    expect(statusLabel(undefined, en)).toBe('—');
    expect(statusLabel('weird', ru)).toBe('weird');
  });
  it('translates agent kinds', () => {
    expect(kindLabel('claude_code', ru)).toBe('Claude Code');
    expect(kindLabel('codex', ru)).toBe('Codex');
    expect(kindLabel('other', ru)).toBe('Другой');
    expect(kindLabel('other', en)).toBe('Other');
    expect(kindLabel('x', ru)).toBe('x');
  });
  it('translates nudge rules', () => {
    expect(ruleLabel('D1', ru)).toBe('незакреплённая работа');
    expect(ruleLabel('JUDGE', ru)).toBe('судья');
    expect(ruleLabel('JUDGE', en)).toBe('judge');
    expect(ruleLabel('Z9', ru)).toBe('Z9');
  });
  it('translates event types and session states, showing unknown codes as they are', () => {
    expect(eventLabel('sent_to_review', ru)).toBe('отправлена на проверку');
    expect(eventLabel('sent_to_review', en)).toBe('sent to review');
    expect(eventLabel('constructor', en)).toBe('constructor'); // not an inherited object key
    expect(sessionStateLabel('stale', ru)).toBe('молчит');
    expect(sessionStateLabel('stale', en)).toBe('silent');
    expect(sessionStateLabel('odd', en)).toBe('odd');
  });
  it('says how long ago, in Russian', () => {
    const now = Date.parse('2026-10-09T12:00:00Z');
    const ago = (ms: number) => relativeTime(new Date(now - ms).toISOString(), ru, now);
    expect(ago(20_000)).toBe('только что');
    expect(ago(-60_000)).toBe('только что'); // a clock a little ahead is not "in the future"
    expect(ago(5 * 60_000)).toBe('5 мин назад');
    expect(ago(3 * 3_600_000)).toBe('3 ч назад');
    expect(ago(30 * 3_600_000)).toBe('вчера');
    expect(ago(4 * 86_400_000)).toBe('4 дн назад');
    expect(ago(30 * 86_400_000)).toMatch(/\d/); // a date
  });
  it('says how long ago, in English, with an English date after a week', () => {
    const now = Date.parse('2026-10-09T12:00:00Z');
    const ago = (ms: number) => relativeTime(new Date(now - ms).toISOString(), en, now);
    expect(ago(20_000)).toBe('just now');
    expect(ago(5 * 60_000)).toBe('5 min ago');
    expect(ago(3 * 3_600_000)).toBe('3 h ago');
    expect(ago(30 * 3_600_000)).toBe('yesterday');
    expect(ago(4 * 86_400_000)).toBe('4 d ago');
    const monthAgo = new Date(now - 30 * 86_400_000);
    expect(ago(30 * 86_400_000)).toBe(monthAgo.toLocaleDateString('en-US', { day: 'numeric', month: 'short' }));
    expect(ago(30 * 86_400_000)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/); // «Sep 9»
    expect(relativeTime(monthAgo.toISOString(), ru, now)).toMatch(/^\d{1,2} сент\.$/);
  });
  it('formats times in the language of the dictionary', () => {
    const iso = new Date(2026, 9, 8, 15, 4).toISOString(); // 8 October, 15:04 local time
    expect(formatTime(iso, en)).toMatch(/^10\/08, 03:04\sPM$/); // month first, 12-hour clock
    expect(formatTime(iso, ru)).toBe('08.10, 15:04'); // day first, 24-hour clock
  });
  it('formats durations compactly', () => {
    expect(formatDuration(20_000, ru)).toBe('<1 мин');
    expect(formatDuration(42 * 60_000, ru)).toBe('42 мин');
    expect(formatDuration(125 * 60_000, ru)).toBe('2 ч 5 мин');
    expect(formatDuration(120 * 60_000, ru)).toBe('2 ч');
    expect(formatDuration(28 * 3_600_000, ru)).toBe('1 д 4 ч');
    expect(formatDuration(48 * 3_600_000, ru)).toBe('2 д');
    expect(formatDuration(20_000, en)).toBe('<1 min');
    expect(formatDuration(125 * 60_000, en)).toBe('2 h 5 min');
    expect(formatDuration(28 * 3_600_000, en)).toBe('1 d 4 h');
  });
  it('makes two-letter initials', () => {
    expect(initials('claude-code@laptop')).toBe('CC');
    expect(initials('codex')).toBe('CO');
    expect(initials('вы')).toBe('ВЫ');
    expect(initials('--')).toBe('?');
  });
});
