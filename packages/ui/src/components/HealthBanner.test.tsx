import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import type { WarningDto } from '../api';
import { en } from '../i18n/en';
import { ru } from '../i18n/ru';
import { apiError, json, renderPage } from '../test-utils';
import { HealthBanner, warningText } from './HealthBanner';

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

// `message` is deliberately not the localized text, so the tests see which one is shown.
const warnings: WarningDto[] = [
  { kind: 'hooks_missing', agentId: 'a1', agentName: 'codex@pc', message: 'fallback 1' },
  { kind: 'agent_silent', agentId: 'a2', agentName: 'old@box', message: 'fallback 2' },
  { kind: 'janitor_interventions', agentId: 'a3', agentName: 'sloppy@box', message: 'fallback 3', count: 22, days: 7 },
  { kind: 'brand_new_kind', agentId: 'a4', agentName: 'x', message: 'The server words a kind this UI does not know.' },
];

const expected = {
  ru: [
    'Агент codex@pc вызывает MCP без регистрации сессии — похоже, хуки не установлены или не одобрены. Запусти `conus doctor` на его машине.',
    'Агент old@box не выходил на связь больше 7 дней.',
    'Агент sloppy@box: сервер 22 раза освобождал задачи после его сессий за 7 дней — агент не закрывает работу сам.',
    'The server words a kind this UI does not know.',
  ],
  en: [
    'Agent codex@pc calls MCP without registering a session — its hooks look missing or not approved. Run `conus doctor` on its machine.',
    'Agent old@box has not been in touch for more than 7 days.',
    'Agent sloppy@box: the server released its tasks 22 times after its sessions in 7 days — the agent does not close its work itself.',
    'The server words a kind this UI does not know.',
  ],
};

describe('HealthBanner', () => {
  it.each(['ru', 'en'] as const)('words every known kind in the UI language (%s) and shows the server text for an unknown one', async (lang) => {
    localStorage.setItem('conus.lang', lang);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ warnings }));
    const { container } = renderPage(<HealthBanner />);
    await screen.findByText(expected[lang][0]!);
    expect(Array.from(container.querySelectorAll('.banner-warn p')).map((p) => p.textContent)).toEqual(expected[lang]);
  });

  it('shows nothing when there are no warnings', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ warnings: [] }));
    const { container } = renderPage(<HealthBanner />);
    await vi.waitFor(() => expect(f).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('says so when the health check itself fails, instead of silently showing nothing', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => apiError(500, 'internal_error', 'Internal error.'));
    renderPage(<HealthBanner />);
    expect((await screen.findByRole('alert')).textContent).toBe('Состояние агентов недоступно: Ошибка сервера — попробуй ещё раз');
  });
});

describe('warningText', () => {
  const janitor = (count: number, days: number): WarningDto =>
    ({ kind: 'janitor_interventions', agentId: 'a', agentName: 'a', message: 'fallback', count, days });

  it('declines the Russian counts', () => {
    expect(warningText(janitor(5, 7), ru)).toContain('сервер 5 раз освобождал');
    expect(warningText(janitor(2, 7), ru)).toContain('сервер 2 раза освобождал');
    expect(warningText(janitor(21, 1), ru)).toContain('сервер 21 раз освобождал задачи после его сессий за 1 день');
    expect(warningText(janitor(3, 3), ru)).toContain('за 3 дня');
  });
  it('declines the English counts', () => {
    expect(warningText(janitor(1, 1), en)).toContain('released its tasks 1 time after its sessions in 1 day');
  });
  it('falls back to the server text when the numbers are missing', () => {
    expect(warningText({ kind: 'janitor_interventions', agentId: 'a', agentName: 'a', message: 'fallback' }, en)).toBe('fallback');
  });
});
