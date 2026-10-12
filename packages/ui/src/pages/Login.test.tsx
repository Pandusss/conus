import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { apiError, json, renderPage } from '../test-utils';
import { Login } from './Login';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.lang = '';
});

async function signIn(button: string) {
  await userEvent.type(await screen.findByLabelText(/Пароль|Password/), 'secret');
  await userEvent.click(screen.getByRole('button', { name: button }));
}

describe('Login', () => {
  it('shows its own text for a wrong password, not the server message', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => apiError(401, 'unauthorized', 'server message'));
    renderPage(<Login onDone={() => {}} />);
    await signIn('Войти');
    expect((await screen.findByRole('alert')).textContent).toBe('Неверный пароль.');
  });

  it('says the same in English', async () => {
    localStorage.setItem('conus.lang', 'en');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => apiError(401, 'unauthorized', 'server message'));
    renderPage(<Login onDone={() => {}} />);
    await signIn('Sign in');
    expect((await screen.findByRole('alert')).textContent).toBe('Wrong password.');
  });

  it('localizes rate limiting', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => apiError(429, 'rate_limited', 'server message'));
    renderPage(<Login onDone={() => {}} />);
    await signIn('Войти');
    expect((await screen.findByRole('alert')).textContent).toBe('Слишком много попыток, подожди минуту.');
  });

  it('switches the language from the login card, and the shown error follows', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => apiError(401, 'unauthorized', 'server message'));
    renderPage(<Login onDone={() => {}} />);
    await signIn('Войти');
    await screen.findByText('Неверный пароль.');
    const picker = screen.getByRole('group', { name: 'Язык' });
    await userEvent.click(within(picker).getByRole('button', { name: 'English' }));
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.getByPlaceholderText('Password')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('Wrong password.');
    expect(screen.getByRole('group', { name: 'Language' })).toBeTruthy();
    expect(within(picker).getByRole('button', { name: 'English' }).getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem('conus.lang')).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('signs in', async () => {
    const onDone = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ ok: true }));
    renderPage(<Login onDone={onDone} />);
    await signIn('Войти');
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('first-run setup', () => {
  /** A server without an owner: /setup says so; POST /setup answers with `answer`. */
  function server(answer: () => Response) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) =>
      String(url).endsWith('/setup') && (init?.method ?? 'GET') === 'GET' ? json({ needed: true }) : answer());
  }
  const fill = async (code: string, password: string, confirm = password) => {
    await userEvent.type(await screen.findByLabelText('Код настройки'), code);
    await userEvent.type(screen.getByLabelText('Пароль владельца'), password);
    await userEvent.type(screen.getByLabelText('Пароль ещё раз'), confirm);
    await userEvent.click(screen.getByRole('button', { name: 'Настроить' }));
  };

  it('checks the password before asking the server, then sends the code and the password', async () => {
    const onDone = vi.fn();
    const f = server(() => json({ ok: true }));
    renderPage(<Login onDone={onDone} />);
    await fill('abcd-efgh', 'short');
    expect((await screen.findByRole('alert')).textContent).toBe('В пароле нужно хотя бы 8 символов.');
    await userEvent.clear(screen.getByLabelText('Пароль владельца'));
    await userEvent.clear(screen.getByLabelText('Пароль ещё раз'));
    await userEvent.type(screen.getByLabelText('Пароль владельца'), 'owner-password');
    await userEvent.type(screen.getByLabelText('Пароль ещё раз'), 'owner-passw0rd');
    await userEvent.click(screen.getByRole('button', { name: 'Настроить' }));
    expect(screen.getByRole('alert').textContent).toBe('Пароли не совпадают.');
    expect(f.mock.calls.filter(([, init]) => init?.method === 'POST')).toEqual([]);

    await userEvent.clear(screen.getByLabelText('Пароль ещё раз'));
    await userEvent.type(screen.getByLabelText('Пароль ещё раз'), 'owner-password');
    await userEvent.click(screen.getByRole('button', { name: 'Настроить' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    const post = f.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(String(post[0])).toMatch(/\/api\/ui\/setup$/);
    expect(JSON.parse(String(post[1]!.body))).toEqual({ code: 'abcd-efgh', password: 'owner-password' });
  });

  it('says so on a wrong setup code', async () => {
    server(() => apiError(403, 'wrong_setup_code'));
    renderPage(<Login onDone={() => {}} />);
    await fill('WRONG-CODE', 'owner-password');
    expect((await screen.findByRole('alert')).textContent).toBe('Неверный код настройки.');
  });

  it('turns into the sign-in form when someone has just set it up', async () => {
    server(() => apiError(409, 'already_set_up'));
    renderPage(<Login onDone={() => {}} />);
    await fill('ABCD-EFGH', 'owner-password');
    expect(await screen.findByText('Conus уже настроен. Войди с паролем владельца.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Войти' })).toBeTruthy();
  });
});
