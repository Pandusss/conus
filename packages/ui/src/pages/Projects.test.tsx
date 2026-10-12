import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { json, mutations, renderPage } from '../test-utils';
import { Projects } from './Projects';

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

const projects = [
  { id: '11111111-1111-4111-8111-111111111111', key: 'WB', name: 'Web', openCount: 3 },
  { id: '22222222-2222-4222-8222-222222222222', key: 'API', name: 'Сервер', openCount: 1 },
];
const mockServer = () => vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
  (((init as RequestInit | undefined)?.method ?? 'GET') === 'GET' ? json({ projects }) : json({ ok: true })));
const mount = () => renderPage(
  <Routes><Route path="/projects" element={<Projects />} /><Route path="/" element={<p>доска</p>} /></Routes>,
  { path: '/projects' },
);
const card = (name: string) => screen.getByRole('article', { name });

describe('Projects', () => {
  it('opens the board filtered by the project', async () => {
    mockServer();
    mount();
    await screen.findByText('Web');
    await userEvent.click(within(card('Web')).getByRole('button', { name: 'Открыть доску' }));
    expect(screen.getByText('доска')).toBeTruthy();
    expect(localStorage.getItem('conus.project')).toBe('WB');
  });

  it('renames through a dialog', async () => {
    const f = mockServer();
    mount();
    await screen.findByText('Web');
    await userEvent.click(within(card('Web')).getByRole('button', { name: 'Переименовать' }));
    const input = screen.getByLabelText('Название');
    await userEvent.clear(input);
    await userEvent.type(input, 'Сайт');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(mutations(f)).toEqual([{ call: `PATCH /api/ui/projects/${projects[0]!.id}`, body: '{"name":"Сайт"}' }]));
  });

  it('merges into a picked project after the warning', async () => {
    const f = mockServer();
    mount();
    await screen.findByText('Web');
    await userEvent.click(within(card('Web')).getByRole('button', { name: 'Объединить…' }));
    const dialog = screen.getByRole('dialog', { name: 'Объединить WB' });
    expect((within(dialog).getByRole('button', { name: 'Объединить' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.selectOptions(within(dialog).getByLabelText('Перенести задачи в'), projects[1]!.id);
    expect(within(dialog).getByText(/переедут в API/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Объединить' }));
    await waitFor(() => expect(mutations(f)).toEqual([
      { call: `POST /api/ui/projects/${projects[0]!.id}/merge`, body: `{"into_id":"${projects[1]!.id}"}` },
    ]));
  });
});
