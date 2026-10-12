import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { apiError, json, mutations, renderPage } from '../test-utils';
import { Agents } from './Agents';
import { CLI_INSTALL } from '../install-command';

afterEach(() => { vi.restoreAllMocks(); Reflect.deleteProperty(navigator, 'clipboard'); });

const agent = {
  id: 'a1', name: 'claude-code@laptop', kind: 'claude_code', tokenPrefix: 'conus_abcdefg', createdAt: '2026-10-01T10:00:00Z',
  revokedAt: null, lastSeenAt: '2026-10-08T10:00:00Z', stats: { sessions: 5, nudges: 4, nudgesActed: 3, janitorReleases: 2 },
};
const isGet = (init: unknown) => ((init as RequestInit | undefined)?.method ?? 'GET') === 'GET';

async function openConnect() {
  await userEvent.click(screen.getAllByRole('button', { name: 'Подключить агента' })[0]!);
  return screen.getByRole('dialog', { name: 'Подключить агента' });
}

describe('Agents', () => {
  it('shows each agent as a card with its kind in Russian, token prefix and 7-day health counters', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ agents: [agent, { ...agent, id: 'a2', name: 'other-one', kind: 'other' }] }));
    renderPage(<Agents />);
    const card = await screen.findByRole('article', { name: 'claude-code@laptop' });
    expect(within(card).getByText('Claude Code')).toBeTruthy();
    expect(within(card).getByText('conus_abcdefg…')).toBeTruthy();
    const stats = within(card).getByLabelText('За 7 дней');
    expect(within(stats).getByText('Сессий').nextElementSibling!.textContent).toBe('5');
    expect(within(stats).getByText('Толчков').nextElementSibling!.textContent).toBe('4отработано 3');
    expect(within(stats).getByText('Сверок').nextElementSibling!.textContent).toBe('2');
    expect(within(screen.getByRole('article', { name: 'other-one' })).getByText('Другой')).toBeTruthy();
  });

  it('shows a failed token creation inside the dialog and keeps the form usable', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
      isGet(init) ? json({ agents: [] }) : apiError(400, 'validation', 'Invalid request body.'));
    renderPage(<Agents />);
    const dialog = await openConnect();
    await userEvent.type(within(dialog).getByLabelText('Имя'), 'x');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Подключить' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Проверь введённые данные');
    expect(mutations(f)).toHaveLength(1);
    expect((within(dialog).getByRole('button', { name: 'Подключить' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the one-time token with the install command of the kind that was created', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
      isGet(init) ? json({ agents: [] }) : json({ agent: { ...agent, name: 'cx', kind: 'codex' }, token: 'conus_SECRET' }));
    renderPage(<Agents />);
    let dialog = await openConnect();
    await userEvent.type(within(dialog).getByLabelText('Имя'), 'cx');
    await userEvent.selectOptions(within(dialog).getByLabelText('Тип'), 'codex');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Подключить' }));
    await waitFor(() => expect(screen.getByText(/conus setup .* conus_SECRET/s).textContent).toContain(CLI_INSTALL));
    expect(screen.queryByRole('dialog')).toBeNull();
    // starting another connection does not touch the token already shown
    dialog = await openConnect();
    await userEvent.selectOptions(within(dialog).getByLabelText('Тип'), 'other');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    expect(screen.getByText(/conus setup .* conus_SECRET/s).textContent).toContain(CLI_INSTALL);
    await userEvent.click(screen.getByRole('button', { name: 'Скрыть' }));
    expect(screen.queryByText(/conus_SECRET/)).toBeNull();
  });

  it('copies the commands to the clipboard', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
      isGet(init) ? json({ agents: [] }) : json({ agent, token: 'conus_SECRET' }));
    renderPage(<Agents />);
    const dialog = await openConnect();
    await userEvent.type(within(dialog).getByLabelText('Имя'), 'cc');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Подключить' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Скопировать' }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('conus setup http'));
    expect(await screen.findByRole('button', { name: 'Скопировано' })).toBeTruthy();
  });

  it('revokes a token only after confirmation', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => (isGet(init) ? json({ agents: [agent] }) : json({ ok: true })));
    renderPage(<Agents />);
    await screen.findByText('claude-code@laptop');
    await userEvent.click(screen.getByRole('button', { name: 'Отозвать' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Отмена' }));
    expect(mutations(f)).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Отозвать' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Отозвать' }));
    await waitFor(() => expect(mutations(f)).toEqual([{ call: 'POST /api/ui/agents/a1/revoke', body: undefined }]));
  });
});
