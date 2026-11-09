import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SettingsDto } from '../api';
import { json, mutations, renderPage } from '../test-utils';
import { Settings } from './Settings';

afterEach(() => vi.restoreAllMocks());

const base: SettingsDto = {
  settings: {
    timeZone: 'Europe/Moscow', digestTime: '09:00', quietFrom: '22:00', quietTo: '08:00', notifyReview: true, notifyBlocked: true,
    remindEveryHours: 3, managerAuto: true, telegramUsername: null, telegramLinked: false,
  },
  telegram: { configured: true, botUsername: 'pandus_conus_bot', error: null },
  manager: { enabled: true, model: 'claude-opus-5-5' },
};

function mockServer(state: SettingsDto = base) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url);
    const method = (init as RequestInit | undefined)?.method ?? 'GET';
    if (u === '/api/ui/telegram/link') return json({ code: 'abc', url: 'https://t.me/pandus_conus_bot?start=abc', expiresAt: '' });
    if (u === '/api/ui/settings' && method === 'PATCH') return json({ ...state, settings: { ...state.settings, ...JSON.parse(String((init as RequestInit).body)) } });
    return json(state);
  });
}

describe('Settings', () => {
  it('links Telegram with a one-time link to the bot', async () => {
    const f = mockServer();
    renderPage(<Settings />);
    expect(await screen.findByText('Бот @pandus_conus_bot работает, но к тебе ещё не привязан.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Привязать Telegram' }));
    expect((await screen.findByRole('link', { name: 'Открыть бота' })).getAttribute('href')).toBe('https://t.me/pandus_conus_bot?start=abc');
    expect(mutations(f)).toEqual([{ call: 'POST /api/ui/telegram/link', body: undefined }]);
  });

  it('shows a linked chat with test and unlink', async () => {
    mockServer({ ...base, settings: { ...base.settings, telegramLinked: true, telegramUsername: 'pandus' } });
    renderPage(<Settings />);
    expect(await screen.findByText('Привязан к @pandus')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Прислать проверочное сообщение' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Отвязать' })).toBeTruthy();
  });

  it('saves the schedule and the manager switch as they change', async () => {
    const f = mockServer();
    renderPage(<Settings />);
    await screen.findByText('Включён, модель claude-opus-5-5.');
    await userEvent.click(screen.getByLabelText('Главный агент сам меняет приоритеты (кроме заданных тобой)'));
    await waitFor(() => expect(mutations(f).at(-1)).toEqual({ call: 'PATCH /api/ui/settings', body: '{"manager_auto":false}' }));
    await userEvent.selectOptions(screen.getByLabelText('Часовой пояс'), 'UTC');
    await waitFor(() => expect(mutations(f).at(-1)).toEqual({ call: 'PATCH /api/ui/settings', body: '{"time_zone":"UTC"}' }));
    const remind = screen.getByLabelText('Напоминания между сводками') as HTMLSelectElement;
    expect(remind.selectedOptions[0]!.textContent).toBe('Каждые 3 часа');
    expect([...remind.options].map((o) => o.textContent).slice(0, 2)).toEqual(['Выключены', 'Каждый час']);
    await userEvent.selectOptions(remind, '6');
    await waitFor(() => expect(mutations(f).at(-1)).toEqual({ call: 'PATCH /api/ui/settings', body: '{"remind_every_hours":6}' }));
  });

  it('explains how to turn on what is off', async () => {
    mockServer({ ...base, telegram: { configured: false, botUsername: null, error: null }, manager: { enabled: false, model: null } });
    renderPage(<Settings />);
    expect(await screen.findByText(/Создай его в @BotFather/)).toBeTruthy();
    expect(screen.getByText(/пропиши ANTHROPIC_API_KEY/)).toBeTruthy();
  });
});
