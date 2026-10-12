import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { HttpError } from '../api';
import { en } from '../i18n/en';
import { ru } from '../i18n/ru';
import { renderPage } from '../test-utils';
import { ErrorLine, errorText } from './ErrorLine';

afterEach(() => vi.restoreAllMocks());

describe('errorText', () => {
  it('maps known error codes to Russian', () => {
    expect(errorText(new HttpError(400, 'validation', 'Invalid request body.'), ru)).toBe('Проверь введённые данные');
    expect(errorText(new HttpError(404, 'not_found', 'Task not found.'), ru)).toBe('Не найдено');
    expect(errorText(new HttpError(409, 'conflict_version', 'x'), ru)).toBe('Задачу изменили параллельно — обнови страницу');
    expect(errorText(new HttpError(409, 'invalid_transition', 'x'), ru)).toBe('Статус уже изменился — обнови список');
    expect(errorText(new HttpError(401, 'unauthorized', 'Нужно войти.'), ru)).toBe('Сессия истекла — войди заново');
  });
  it('falls back to the server message, then to a generic text', () => {
    expect(errorText(new HttpError(409, 'something_new', 'Сервер говорит так'), ru)).toBe('Сервер говорит так');
    expect(errorText(new HttpError(502, 'error', 'Bad Gateway'), ru)).toBe('Ошибка сервера (502)');
    expect(errorText(new HttpError(418, 'error', ''), ru)).toBe('Ошибка (418)');
    expect(errorText(new HttpError(404, 'error', 'Not Found'), ru)).toBe('Не найдено');
    expect(errorText(new HttpError(200, 'error', 'OK'), ru)).toBe('Неожиданный ответ сервера');
    expect(errorText(new HttpError(413, 'error', 'Payload Too Large'), ru)).toBe('Ошибка (413)'); // not the proxy's English
    expect(errorText(new TypeError('Failed to fetch'), ru)).toBe('Нет связи с сервером');
    expect(errorText(new Error('boom'), ru)).toBe('Ошибка');
  });
  it('speaks English with the English dictionary', () => {
    expect(errorText(new HttpError(409, 'conflict_version', 'x'), en)).toBe('The task was changed meanwhile — reload the page');
    expect(errorText(new HttpError(429, 'rate_limited', 'x'), en)).toBe('Too many attempts. Try again in a minute.');
    expect(errorText(new HttpError(502, 'error', 'Bad Gateway'), en)).toBe('Server error (502)');
    expect(errorText(new TypeError('Failed to fetch'), en)).toBe('Cannot reach the server');
    expect(errorText(new Error('boom'), en)).toBe('Something went wrong');
  });
});

describe('ErrorLine', () => {
  it('renders nothing without an error', () => {
    const { container } = renderPage(<ErrorLine error={null} />);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
  it('renders the message as an alert', () => {
    renderPage(<ErrorLine error={new HttpError(404, 'not_found', 'x')} />);
    expect(screen.getByRole('alert').textContent).toBe('Не найдено');
  });
  it('asks the app to re-check the session on 401 (which shows the login form)', async () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    renderPage(<ErrorLine error={new HttpError(401, 'unauthorized', 'x')} />, { client });
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: ['me'] }));
  });
  it('does not touch the session for other errors', () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    renderPage(<ErrorLine error={new HttpError(409, 'conflict_version', 'x')} />, { client });
    expect(spy).not.toHaveBeenCalled();
  });
});
