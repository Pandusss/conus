import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { useProjectFilter } from '../project-filter';
import { json, renderPage, taskDto } from '../test-utils';
import { Shell } from './Shell';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  document.documentElement.lang = '';
});

function mockServer() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const u = String(url);
    if (u === '/api/ui/health') return json({ warnings: [] });
    if (u === '/api/ui/projects') return json({ projects: [{ id: 'p1', key: 'WB', name: 'Web', openCount: 4 }] });
    if (u === '/api/ui/sessions') return json({ sessions: [{ id: 's1', state: 'active' }] });
    return json({ tasks: [taskDto({ status: 'proposed' }), taskDto({ id: 't2', status: 'proposed' })] });
  });
}
function Filter() {
  return <p data-testid="filter">{useProjectFilter().project || 'все'}</p>;
}
const mount = (path = '/agents') => renderPage(
  <Shell onLogout={() => {}} loggingOut={false}>
    <Routes><Route path="/" element={<Filter />} /><Route path="*" element={<p>другая страница</p>} /></Routes>
  </Shell>,
  { path },
);

describe('Shell', () => {
  it('counts proposals, marks live sessions and lists projects with their open counts', async () => {
    mockServer();
    mount();
    expect(await screen.findByRole('link', { name: /Предложения 2/ })).toBeTruthy();
    expect(await screen.findByTitle('Есть активные сессии')).toBeTruthy();
    expect((await screen.findByRole('button', { name: /Web/ })).textContent).toContain('4');
  });

  it('filters the board by a project picked in the sidebar', async () => {
    mockServer();
    mount();
    await userEvent.click(await screen.findByRole('button', { name: /Web/ }));
    expect(screen.getByTestId('filter').textContent).toBe('WB');
    expect(localStorage.getItem('conus.project')).toBe('WB');
    await userEvent.click(screen.getByRole('button', { name: 'Все проекты' }));
    expect(screen.getByTestId('filter').textContent).toBe('все');
  });

  it('toggles the theme and remembers the choice', async () => {
    mockServer();
    mount();
    const toggle = screen.getByRole('switch', { name: 'Тёмная тема' });
    expect(toggle.getAttribute('aria-checked')).toBe('false'); // jsdom has no dark system preference
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(localStorage.getItem('conus.theme')).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    await userEvent.click(toggle);
    expect(localStorage.getItem('conus.theme')).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('starts from a remembered theme', () => {
    localStorage.setItem('conus.theme', 'dark');
    mockServer();
    mount();
    expect(screen.getByRole('switch', { name: 'Тёмная тема' }).getAttribute('aria-checked')).toBe('true');
  });

  it('switches the language next to the theme toggle and remembers the choice', async () => {
    mockServer();
    mount();
    expect(await screen.findByRole('link', { name: /Предложения 2/ })).toBeTruthy();
    const picker = screen.getByRole('group', { name: 'Язык' });
    expect(within(picker).getByRole('button', { name: 'Русский' }).getAttribute('aria-pressed')).toBe('true');
    await userEvent.click(within(picker).getByRole('button', { name: 'English' }));
    expect(screen.getByRole('link', { name: /Proposals 2/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Log out' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Dark theme' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Language' })).toBe(picker);
    expect(within(picker).getByRole('button', { name: 'English' }).getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem('conus.lang')).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    await userEvent.click(within(picker).getByRole('button', { name: 'Русский' }));
    expect(screen.getByRole('button', { name: 'Выйти' })).toBeTruthy();
    expect(localStorage.getItem('conus.lang')).toBe('ru');
  });

  it('opens the navigation drawer from the top bar and closes it on Esc', async () => {
    mockServer();
    mount();
    await userEvent.click(screen.getByRole('button', { name: 'Открыть меню' }));
    expect(document.getElementById('sidebar')!.className).toContain('is-open');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(document.getElementById('sidebar')!.className).not.toContain('is-open'));
  });
});
