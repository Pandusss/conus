import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { apiError, json, mutations, renderPage, taskDto } from '../test-utils';
import { TaskDrawer } from './TaskDrawer';

afterEach(() => vi.restoreAllMocks());

const ID = '11111111-1111-4111-8111-111111111111';
const task = taskDto({ id: ID, ref: 'WB-3', title: 'Починить логин', description: 'подробности', version: 3 });
const detail = { task, events: [], links: [], subtasks: [] };

function mockServer(post: () => Response | Promise<Response> = () => json({ ok: true })) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url);
    if (((init as RequestInit | undefined)?.method ?? 'GET') !== 'GET') return post();
    if (u === `/api/ui/tasks/${ID}`) return json(detail);
    if (u.startsWith('/api/ui/tasks?')) return json({ tasks: [] });
    return apiError(404, 'not_found');
  });
}

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}
/** The drawer at /tasks/:id, plus the current path so closing (→ /) can be seen. */
const mount = () => renderPage(
  <><Routes><Route path="/" element={null} /><Route path="/tasks/:id" element={<TaskDrawer />} /></Routes><Where /></>,
  { path: `/tasks/${ID}` },
);
const statusButton = () => screen.getByRole('button', { name: /^Статус:/ });
async function pickStatus(label: string) {
  await userEvent.click(statusButton());
  await userEvent.click(screen.getByRole('menuitem', { name: label }));
}

describe('TaskDrawer', () => {
  it('says "not found" instead of loading forever when the task does not exist', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => apiError(404, 'not_found', 'Task not found.'));
    mount();
    expect((await screen.findByRole('alert')).textContent).toBe('Не найдено');
    expect(screen.queryByText('Загрузка…')).toBeNull();
  });

  it('shows the meta grid, holder with its session and the history sections', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({
      ...detail,
      task: { ...task, status: 'in_progress', result: null, holder: { agentName: 'claude-code@laptop', sessionRef: 'S-9', sessionId: 's9' } },
      links: [{ id: 1, kind: 'commit', ref: 'abcdef1234567', meta: { subject: 'fix: логин' } }],
    }));
    mount();
    expect(await screen.findByRole('link', { name: 'S-9' })).toBeTruthy();
    expect(screen.getByText('claude-code@laptop')).toBeTruthy();
    expect(screen.getByText('abcdef1')).toBeTruthy();
    expect(screen.getByText('fix: логин')).toBeTruthy();
    expect(statusButton().textContent).toContain('В работе');
  });

  it('closes on Esc and goes back to the board', async () => {
    mockServer();
    mount();
    await screen.findByText('Починить логин');
    await userEvent.keyboard('{Escape}');
    expect(screen.getByTestId('where').textContent).toBe('/');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('saves with the version captured when editing started, even if the task was refreshed meanwhile', async () => {
    const f = mockServer();
    const { client } = mount();
    await screen.findByText('Починить логин');
    await userEvent.click(screen.getByRole('button', { name: 'Изменить' }));
    act(() => client.setQueryData(['task', ID], { ...detail, task: { ...task, version: 4 } }));
    const title = screen.getByLabelText('Название');
    await userEvent.clear(title);
    await userEvent.type(title, 'Новое имя');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(mutations(f)).toHaveLength(1));
    expect(mutations(f)[0]!.call).toBe(`PATCH /api/ui/tasks/${ID}`);
    expect(JSON.parse(mutations(f)[0]!.body!)).toEqual({ title: 'Новое имя', description: 'подробности', expected_version: 3 });
  });

  it('pulls the current version after an optimistic-lock conflict on save', async () => {
    const f = mockServer(() => apiError(409, 'conflict_version', 'changed'));
    mount();
    await screen.findByText('Починить логин');
    const before = f.mock.calls.filter(([u]) => String(u) === `/api/ui/tasks/${ID}`).length;
    await userEvent.click(screen.getByRole('button', { name: 'Изменить' }));
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Задачу изменили параллельно — обнови страницу');
    await waitFor(() => expect(f.mock.calls.filter(([u]) => String(u) === `/api/ui/tasks/${ID}`).length).toBeGreaterThan(before));
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeTruthy(); // the draft survives
  });

  it('does nothing when the reason dialog for dropping or blocking is cancelled', async () => {
    const f = mockServer();
    mount();
    await screen.findByText('Починить логин');
    await pickStatus('Отменена');
    await userEvent.click(within(screen.getByRole('dialog', { name: /Отменить WB-3/ })).getByRole('button', { name: 'Отмена' }));
    await pickStatus('Заблокирована');
    await userEvent.keyboard('{Escape}'); // Esc closes the reason dialog only, not the drawer
    expect(screen.queryByRole('dialog', { name: /Заблокировать/ })).toBeNull();
    expect(screen.getByText('Починить логин')).toBeTruthy();
    expect(mutations(f)).toEqual([]);
  });

  it('changes status without asking for ordinary statuses, and with the typed reason for dropped', async () => {
    const f = mockServer();
    mount();
    await screen.findByText('Починить логин');
    await pickStatus('На проверке');
    await waitFor(() => expect(mutations(f)).toHaveLength(1));
    expect(screen.queryByRole('dialog', { name: /Отменить/ })).toBeNull();
    await pickStatus('Отменена');
    await userEvent.type(screen.getByLabelText(/Почему отменяем/), 'не нужно');
    await userEvent.click(screen.getByRole('button', { name: 'Отменить задачу' }));
    await waitFor(() => expect(mutations(f)).toHaveLength(2));
    expect(JSON.parse(mutations(f)[1]!.body!)).toEqual({ status: 'dropped', reason: 'не нужно' });
  });

  it('shows a failed action, and clears the message once the next action starts', async () => {
    let n = 0;
    mockServer(() => (++n === 1 ? apiError(409, 'conflict_version', 'changed') : json({ ok: true })));
    mount();
    await screen.findByText('Починить логин');
    await pickStatus('На проверке');
    expect((await screen.findByRole('alert')).textContent).toBe('Задачу изменили параллельно — обнови страницу');
    await waitFor(() => expect(statusButton().textContent).toContain('К выполнению')); // rolled back
    await pickStatus('На проверке');
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('disables the controls while an action is in flight', async () => {
    mockServer(() => new Promise<Response>(() => {}));
    mount();
    await screen.findByText('Починить логин');
    await pickStatus('На проверке');
    await waitFor(() => expect((statusButton() as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByRole('button', { name: 'Действия с задачей' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Изменить' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('deletes only after confirmation, then invalidates the task lists and goes back to the board', async () => {
    const f = mockServer();
    const { client } = mount();
    const spy = vi.spyOn(client, 'invalidateQueries');
    await screen.findByText('Починить логин');
    await userEvent.click(screen.getByRole('button', { name: 'Действия с задачей' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Удалить' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Удалить задачу?' })).getByRole('button', { name: 'Отмена' }));
    expect(mutations(f)).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Действия с задачей' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Удалить' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Удалить задачу?' })).getByRole('button', { name: 'Удалить' }));
    await waitFor(() => expect(mutations(f)).toEqual([{ call: `DELETE /api/ui/tasks/${ID}`, body: undefined }]));
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: ['tasks'] }));
    expect(screen.getByTestId('where').textContent).toBe('/');
  });

  it('marks the task as a duplicate of a picked sibling', async () => {
    const MAIN = '44444444-4444-4444-8444-444444444444';
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      if (((init as RequestInit | undefined)?.method ?? 'GET') !== 'GET') return json({ ok: true });
      if (u.startsWith('/api/ui/tasks?')) return json({ tasks: [task, taskDto({ id: MAIN, ref: 'WB-1', title: 'Основная' })] });
      return json(detail);
    });
    mount();
    await screen.findByText('Починить логин');
    await userEvent.click(screen.getByRole('button', { name: 'Действия с задачей' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Это дубль задачи…' }));
    const dialog = screen.getByRole('dialog', { name: /дубль задачи/ });
    await waitFor(() => expect(within(dialog).getAllByRole('option')).toHaveLength(2)); // itself is not offered
    await userEvent.selectOptions(within(dialog).getByLabelText('Основная задача'), MAIN);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Объединить' }));
    await waitFor(() => expect(mutations(f)).toEqual([{ call: `POST /api/ui/tasks/${ID}/merge`, body: `{"into_id":"${MAIN}"}` }]));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe(`/tasks/${MAIN}`));
  });

  it('does not carry the edit draft or the action error over to another task', async () => {
    const SUB = '33333333-3333-4333-8333-333333333333';
    const sub = taskDto({ id: SUB, ref: 'WB-4', title: 'Подзадача', parentId: ID, parentRef: 'WB-3' });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      if (((init as RequestInit | undefined)?.method ?? 'GET') !== 'GET') return apiError(409, 'conflict_version', 'changed');
      if (u === `/api/ui/tasks/${ID}`) return json({ ...detail, subtasks: [sub] });
      if (u === `/api/ui/tasks/${SUB}`) return json({ task: sub, events: [], links: [], subtasks: [] });
      if (u.startsWith('/api/ui/tasks?')) return json({ tasks: [] });
      return apiError(404, 'not_found');
    });
    mount();
    await screen.findByText('Починить логин');
    await pickStatus('На проверке'); // fails: leaves an action error on this task
    await screen.findByRole('alert');
    await userEvent.click(screen.getByRole('button', { name: 'Изменить' })); // opens an edit draft
    expect(screen.getByRole('button', { name: 'Сохранить' })).toBeTruthy();
    await userEvent.click(screen.getByRole('link', { name: /WB-4/ })); // go to the subtask
    expect(await screen.findByText('Подзадача', { selector: 'h2' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Сохранить' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Изменить' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'WB-3' })).toBeTruthy(); // the parent link
  });
});
