import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TaskDto } from '../api';
import { apiError, json, mutations, renderPage, taskDto } from '../test-utils';
import { Board } from './Board';

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

const task = taskDto({ id: 't1', ref: 'WB-1', title: 'Починить логин' });
const projects = [{ id: 'p1', key: 'WB', name: 'Web', openCount: 1 }];

/** GET /projects and /tasks answer from the fixtures; everything else (status changes) is answered by `post`. */
function mockServer(tasks: TaskDto[] = [task], post: () => Response | Promise<Response> = () => json({ ok: true })) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url);
    if (((init as RequestInit | undefined)?.method ?? 'GET') !== 'GET') return post();
    if (u.startsWith('/api/ui/projects')) return json({ projects });
    if (u.startsWith('/api/ui/tasks?')) return json({ tasks });
    return apiError(404, 'not_found');
  });
}
const requested = (f: { mock: { calls: unknown[][] } }) => f.mock.calls.map(([u]) => String(u));
const column = (name: string) => screen.getByRole('region', { name });
const card = (title: string) => screen.getByText(title).closest('article')!;
const projectSelect = () => screen.getByLabelText('Проект') as HTMLSelectElement;

function drag(from: HTMLElement, to: HTMLElement) {
  fireEvent.dragStart(from);
  fireEvent.dragOver(to);
  fireEvent.drop(to);
}

describe('Board filters', () => {
  it('forgets a stored project key that is not in the project list', async () => {
    localStorage.setItem('conus.project', 'GONE');
    const f = mockServer();
    renderPage(<Board />);
    expect(await screen.findByText('Починить логин')).toBeTruthy();
    expect(localStorage.getItem('conus.project')).toBeNull();
    expect(requested(f).some((u) => u.includes('project=GONE'))).toBe(false);
    expect(projectSelect().value).toBe('');
  });

  it('keeps a stored project key that still exists', async () => {
    localStorage.setItem('conus.project', 'WB');
    const f = mockServer();
    renderPage(<Board />);
    await screen.findByText('Починить логин');
    expect(localStorage.getItem('conus.project')).toBe('WB');
    expect(requested(f).some((u) => u.startsWith('/api/ui/tasks?') && u.includes('project=WB'))).toBe(true);
    expect(projectSelect().value).toBe('WB');
  });

  it('remembers the picked project', async () => {
    mockServer();
    renderPage(<Board />);
    await screen.findByText('Починить логин');
    await waitFor(() => expect(within(projectSelect()).getAllByRole('option')).toHaveLength(2));
    await userEvent.selectOptions(projectSelect(), 'WB');
    expect(localStorage.getItem('conus.project')).toBe('WB');
  });

  it('still renders when the browser denies localStorage access', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    mockServer();
    renderPage(<Board />);
    expect(await screen.findByText('Починить логин')).toBeTruthy();
  });

  it('shows an error when the tasks cannot be loaded', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => (String(url).startsWith('/api/ui/projects') ? json({ projects }) : apiError(500, 'internal_error')));
    renderPage(<Board />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Ошибка сервера — попробуй ещё раз'));
  });

  it('filters by ref and title on the client, and «/» focuses the search', async () => {
    mockServer([task, taskDto({ id: 't2', ref: 'WB-2', title: 'Обновить зависимости', type: 'bug' })]);
    renderPage(<Board />);
    await screen.findByText('Починить логин');
    await userEvent.keyboard('/');
    const search = screen.getByRole('searchbox');
    expect(document.activeElement).toBe(search);
    await userEvent.type(search, 'логин');
    expect(screen.queryByText('Обновить зависимости')).toBeNull();
    expect(screen.getByText('Починить логин')).toBeTruthy();
    await userEvent.clear(search);
    await userEvent.type(search, 'wb-2');
    expect(screen.queryByText('Починить логин')).toBeNull();
    expect(screen.getByText('Обновить зависимости')).toBeTruthy();
    await userEvent.clear(search);
    await userEvent.click(screen.getByRole('button', { name: 'Только баги' }));
    expect(screen.queryByText('Починить логин')).toBeNull();
    expect(screen.getByText('Обновить зависимости')).toBeTruthy();
  });

  it('asks for dropped tasks only when «Отменённые» is on', async () => {
    const f = mockServer();
    renderPage(<Board />);
    await screen.findByText('Починить логин');
    expect(screen.queryByRole('region', { name: 'Отменена' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Отменённые' }));
    expect(column('Отменена')).toBeTruthy();
    await waitFor(() => expect(requested(f).some((u) => u.includes('status=todo,in_progress,blocked,review,done,dropped'))).toBe(true));
  });
});

describe('Board cards', () => {
  it('shows the holder, counts, status details and the project chip only for all projects', async () => {
    mockServer([
      taskDto({
        id: 't1', title: 'В работе у агента', status: 'in_progress', subtaskCount: 2, commitCount: 3,
        holder: { agentName: 'claude-code@laptop', sessionRef: 'S-1', sessionId: 's1' },
      }),
      taskDto({ id: 't2', ref: 'WB-2', title: 'Стоит', status: 'blocked', blockReason: 'ждём ключи' }),
      taskDto({ id: 't3', ref: 'WB-3', title: 'Проверить', status: 'review' }),
    ]);
    renderPage(<Board />);
    await screen.findByText('В работе у агента');
    const c = card('В работе у агента');
    expect(within(c).getByText('claude-code@laptop')).toBeTruthy();
    expect(within(c).getByTitle('Подзадач: 2').textContent).toBe('2');
    expect(within(c).getByTitle('Коммитов: 3').textContent).toBe('3');
    expect(within(c).getByText('WB')).toBeTruthy(); // project chip
    expect(within(card('Стоит')).getByText('ждём ключи')).toBeTruthy();
    expect(within(card('Проверить')).getByText('ждёт проверки')).toBeTruthy();
  });

  it('shows the 20 most recent done tasks, then all of them on request', async () => {
    mockServer(Array.from({ length: 25 }, (_, i) => taskDto({ id: `d${i}`, ref: `WB-${i + 1}`, title: `Готовая ${i + 1}`, status: 'done' })));
    renderPage(<Board />);
    await screen.findByText('Готовая 1');
    const done = column('Готово');
    expect(within(done).getAllByRole('article')).toHaveLength(20);
    await userEvent.click(within(done).getByRole('button', { name: 'Показать все (25)' }));
    expect(within(done).getAllByRole('article')).toHaveLength(25);
    expect(within(column('В работе')).getByText('Пусто')).toBeTruthy();
  });
});

describe('Board status changes', () => {
  it('moves a dropped card to its new column at once and calls the API', async () => {
    const f = mockServer([task], () => new Promise<Response>(() => {}));
    renderPage(<Board />);
    await screen.findByText('Починить логин');
    drag(card('Починить логин'), column('В работе'));
    await waitFor(() => expect(within(column('В работе')).getByText('Починить логин')).toBeTruthy());
    expect(within(column('К выполнению')).queryByText('Починить логин')).toBeNull();
    expect(mutations(f)).toEqual([{ call: 'POST /api/ui/tasks/t1/status', body: '{"status":"in_progress"}' }]);
  });

  it('puts the card back and shows the error when the server refuses the move', async () => {
    mockServer([task], () => apiError(409, 'invalid_transition', 'nope'));
    renderPage(<Board />);
    await screen.findByText('Починить логин');
    drag(card('Починить логин'), column('На проверке'));
    expect((await screen.findByRole('alert')).textContent).toBe('Статус уже изменился — обнови список');
    expect(within(column('К выполнению')).getByText('Починить логин')).toBeTruthy();
    expect(within(column('На проверке')).queryByText('Починить логин')).toBeNull();
  });

  it('asks for a reason before blocking; Cancel aborts the move', async () => {
    const f = mockServer();
    renderPage(<Board />);
    await screen.findByText('Починить логин');
    drag(card('Починить логин'), column('Заблокирована'));
    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Заблокировать' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true); // a block needs a reason
    await userEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mutations(f)).toEqual([]);
    expect(within(column('К выполнению')).getByText('Починить логин')).toBeTruthy();
  });

  it('blocks with the typed reason', async () => {
    const f = mockServer();
    renderPage(<Board />);
    await screen.findByText('Починить логин');
    drag(card('Починить логин'), column('Заблокирована'));
    await userEvent.type(screen.getByLabelText('Что мешает?'), 'ждём ключи');
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Заблокировать' }));
    await waitFor(() => expect(mutations(f)).toEqual([{ call: 'POST /api/ui/tasks/t1/status', body: '{"status":"blocked","reason":"ждём ключи"}' }]));
  });

  it('changes status from the card menu, for keyboard and touch users', async () => {
    const f = mockServer();
    renderPage(<Board />);
    await screen.findByText('Починить логин');
    await userEvent.click(screen.getByRole('button', { name: 'Действия с WB-1' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'На проверке' }));
    await waitFor(() => expect(mutations(f)).toEqual([{ call: 'POST /api/ui/tasks/t1/status', body: '{"status":"review"}' }]));
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
