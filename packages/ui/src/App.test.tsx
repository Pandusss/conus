import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen, within } from '@testing-library/react';
import { App } from './App';
import { apiError, json, renderPage, taskDto } from './test-utils';

afterEach(() => vi.restoreAllMocks());

describe('App', () => {
  it('reports an unreachable or broken server instead of showing a login form', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('<html>502</html>', { status: 502, statusText: 'Bad Gateway' }));
    renderPage(<App />);
    expect((await screen.findByRole('alert')).textContent).toBe('Ошибка сервера (502)');
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeTruthy();
    expect(screen.queryByPlaceholderText('Пароль')).toBeNull();
  });

  it('shows the login form when not authenticated', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ authenticated: false }));
    renderPage(<App />);
    expect(await screen.findByPlaceholderText('Пароль')).toBeTruthy();
  });

  it('speaks English to a browser that is not Russian, unless Russian was picked', async () => {
    localStorage.removeItem('conus.lang'); // the test setup pins Russian
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['de-DE', 'en']);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ authenticated: false }));
    renderPage(<App />);
    expect(await screen.findByPlaceholderText('Password')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });

  it('returns to the login form when the session expires while using a page', async () => {
    let authenticated = true;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u === '/api/ui/me') return json({ authenticated });
      if (u === '/api/ui/health') return json({ warnings: [] });
      if (u === '/api/ui/projects') return json({ projects: [] });
      authenticated = false; // the owner session is gone by the time the board asks for tasks
      return apiError(401, 'unauthorized', 'Нужно войти.');
    });
    renderPage(<App />);
    expect(await screen.findByPlaceholderText('Пароль')).toBeTruthy();
  });

  it('reports a failed /me refetch instead of falling back to the login form when the cached answer was "not signed in"', async () => {
    let meFails = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      meFails ? new Response('<html>502</html>', { status: 502, statusText: 'Bad Gateway' }) : json({ authenticated: false }));
    const { client } = renderPage(<App />);
    await screen.findByPlaceholderText('Пароль');
    meFails = true; // e.g. the login just succeeded, but the follow-up /me refetch hits a broken proxy
    await act(async () => { await client.refetchQueries({ queryKey: ['me'] }); });
    expect((await screen.findByRole('alert')).textContent).toBe('Ошибка сервера (502)');
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeTruthy();
    expect(screen.queryByPlaceholderText('Пароль')).toBeNull();
  });

  it('opens a direct task link as the drawer over the board', async () => {
    const ID = '11111111-1111-4111-8111-111111111111';
    const task = taskDto({ id: ID, ref: 'WB-3', title: 'Починить логин' });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u === '/api/ui/me') return json({ authenticated: true });
      if (u === '/api/ui/health') return json({ warnings: [] });
      if (u === '/api/ui/projects') return json({ projects: [{ id: 'p1', key: 'WB', name: 'Web', openCount: 1 }] });
      if (u === '/api/ui/sessions') return json({ sessions: [] });
      if (u === `/api/ui/tasks/${ID}`) return json({ task, events: [], links: [], subtasks: [] });
      return json({ tasks: [task] });
    });
    renderPage(<App />, { path: `/tasks/${ID}` });
    const drawer = await screen.findByRole('dialog', { name: 'Задача' });
    expect(await within(drawer).findByRole('heading', { name: 'Починить логин' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Доска', level: 1 })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Доска' }).className).toContain('is-active');
  });

  it('keeps the app mounted when a background refetch of /me fails', async () => {
    let meFails = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u === '/api/ui/me') return meFails ? new Response('<html>502</html>', { status: 502, statusText: 'Bad Gateway' }) : json({ authenticated: true });
      if (u === '/api/ui/health') return json({ warnings: [] });
      if (u === '/api/ui/projects') return json({ projects: [] });
      return json({ tasks: [] });
    });
    const { client } = renderPage(<App />);
    await screen.findByRole('link', { name: 'Доска' });
    meFails = true;
    await act(async () => { await client.refetchQueries({ queryKey: ['me'] }); });
    expect(client.getQueryState(['me'])?.error).toBeTruthy(); // the refetch did fail...
    expect(screen.getByRole('link', { name: 'Доска' })).toBeTruthy(); // ...but the app (drafts, one-time token) stays mounted
    expect(screen.queryByRole('button', { name: 'Повторить' })).toBeNull();
  });
});
