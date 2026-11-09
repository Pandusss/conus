import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { apiError, json, mutations, renderPage, taskDto } from '../test-utils';
import { Proposals } from './Proposals';

afterEach(() => vi.restoreAllMocks());

const proposal = taskDto({ id: 'p1', ref: 'WB-7', title: 'Переделать кэш', status: 'proposed', sourceQuote: 'надо бы когда-нибудь кэш переделать' });

/** GET /tasks returns the proposal; everything else is answered by `post`. */
function mockServer(post: () => Response | Promise<Response> = () => json({ ok: true })) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (((init as RequestInit | undefined)?.method ?? 'GET') === 'GET') {
      return String(url).startsWith('/api/ui/tasks?') ? json({ tasks: [proposal] }) : apiError(404, 'not_found');
    }
    return post();
  });
}
const rejectButton = () => screen.getByRole('button', { name: 'Отклонить' });
const dialog = () => screen.getByRole('dialog', { name: 'Отклонить WB-7' });

describe('Proposals', () => {
  it('shows the project, the source quote and accepts a proposal', async () => {
    const f = mockServer();
    renderPage(<Proposals />);
    expect(await screen.findByText('Переделать кэш')).toBeTruthy();
    expect(screen.getByText(/надо бы когда-нибудь кэш переделать/)).toBeTruthy();
    expect(screen.getByText('WB')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Принять' }));
    await waitFor(() => expect(mutations(f)).toEqual([{ call: 'POST /api/ui/proposals/p1/accept', body: '{}' }]));
  });

  it('explains the empty inbox', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ tasks: [] }));
    renderPage(<Proposals />);
    expect(await screen.findByText('Предложений нет')).toBeTruthy();
    expect(screen.getByText(/агенты кладут идеи/)).toBeTruthy();
  });
});

describe('Proposals reject', () => {
  it('does nothing when the reason dialog is cancelled', async () => {
    const f = mockServer();
    renderPage(<Proposals />);
    await screen.findByText('Переделать кэш');
    await userEvent.click(rejectButton());
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Отмена' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(rejectButton());
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mutations(f)).toEqual([]);
  });

  it('rejects without a reason when the dialog is confirmed empty', async () => {
    const f = mockServer();
    renderPage(<Proposals />);
    await screen.findByText('Переделать кэш');
    await userEvent.click(rejectButton());
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Отклонить' }));
    await waitFor(() => expect(mutations(f)).toEqual([{ call: 'POST /api/ui/proposals/p1/reject', body: '{}' }]));
  });

  it('rejects with the typed reason', async () => {
    const f = mockServer();
    renderPage(<Proposals />);
    await screen.findByText('Переделать кэш');
    await userEvent.click(rejectButton());
    await userEvent.type(within(dialog()).getByRole('textbox'), '  дубль ');
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Отклонить' }));
    await waitFor(() => expect(mutations(f)).toEqual([{ call: 'POST /api/ui/proposals/p1/reject', body: '{"reason":"дубль"}' }]));
  });
});

describe('Proposals errors and pending state', () => {
  it('shows a readable error when the action fails and clears it on the next attempt', async () => {
    let n = 0;
    mockServer(() => (++n === 1 ? apiError(409, 'invalid_transition', 'WB-7 is not a proposal') : json({ ok: true })));
    renderPage(<Proposals />);
    await screen.findByText('Переделать кэш');
    await userEvent.click(screen.getByRole('button', { name: 'Принять' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Статус уже изменился — обнови список');
    await userEvent.click(screen.getByRole('button', { name: 'Принять' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('disables the action buttons while the request is in flight', async () => {
    const f = mockServer(() => new Promise<Response>(() => {}));
    renderPage(<Proposals />);
    await screen.findByText('Переделать кэш');
    const accept = screen.getByRole('button', { name: 'Принять' }) as HTMLButtonElement;
    const reject = rejectButton() as HTMLButtonElement;
    await userEvent.click(accept);
    await waitFor(() => expect(accept.disabled).toBe(true));
    expect(reject.disabled).toBe(true);
    await userEvent.click(accept);
    expect(mutations(f)).toHaveLength(1);
  });

  it('shows the load error instead of the empty-inbox text', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => apiError(500, 'internal_error', 'Internal error.'));
    renderPage(<Proposals />);
    expect((await screen.findByRole('alert')).textContent).toBe('Ошибка сервера — попробуй ещё раз');
    expect(screen.queryByText('Предложений нет')).toBeNull();
  });

  it('sorts pasted correspondence into proposals and shows what came out', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      if (u === '/api/ui/settings') return json({ manager: { enabled: true, model: 'claude-opus-5-5' } });
      if (u === '/api/ui/intake') {
        return json({ batch: {
          id: 1, source: 'web', status: 'done', summary: 'Клиент просит экспорт.', error: null, createdAt: '',
          tasks: [taskDto({ id: 'n1', ref: 'WB-9', title: 'Починить экспорт в Safari', status: 'proposed', priority: 'urgent' })],
          duplicates: [{ title: 'Тёмная тема', ref: 'WB-2', existingTitle: 'Тёмная тема для графиков' }],
        } });
      }
      return json({ tasks: [] });
    });
    renderPage(<Proposals />);
    await userEvent.type(await screen.findByLabelText('Переписка или заметки'), 'Анна: экспорт сломан');
    await userEvent.click(screen.getByRole('button', { name: 'Разложить по проектам' }));
    expect(await screen.findByText('Клиент просит экспорт.')).toBeTruthy();
    expect(screen.getByText('Починить экспорт в Safari')).toBeTruthy();
    expect(screen.getByText('Тёмная тема для графиков')).toBeTruthy();
    expect(mutations(f)).toEqual([{ call: 'POST /api/ui/intake', body: '{"text":"Анна: экспорт сломан"}' }]);
  });

  it('says the manager is needed when there is no key', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      json(String(url) === '/api/ui/settings' ? { manager: { enabled: false, model: null } } : { tasks: [] }));
    renderPage(<Proposals />);
    expect(await screen.findByText(/Для разбора переписки нужен главный агент/)).toBeTruthy();
    expect(screen.queryByLabelText('Переписка или заметки')).toBeNull();
  });
});
