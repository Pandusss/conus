import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import type { OverviewDto, ProjectOverviewDto } from '../api';
import { localToday } from '../labels';
import { json, renderPage, taskDto } from '../test-utils';
import { Overview } from './Overview';

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

const day = (d: number) => { const x = new Date(); x.setDate(x.getDate() + d); return localToday(x); };
const counts = (over: Partial<ProjectOverviewDto['counts']> = {}) => ({ proposed: 0, todo: 0, in_progress: 0, blocked: 0, review: 0, ...over });
const project = (over: Partial<ProjectOverviewDto>): ProjectOverviewDto => ({
  id: 'p1', key: 'WB', name: 'Web', counts: counts(), doneThisWeek: 0, lastActivityAt: new Date().toISOString(), live: [],
  inProgress: [], blocked: [], review: [], next: [], quiet: false, ...over,
});

const doing = taskDto({ id: 'a', ref: 'WB-1', title: 'Экспорт в CSV', status: 'in_progress', holder: { agentName: 'claude-code@mac', sessionRef: 'S-1', sessionId: 's1' } });
const check = taskDto({ id: 'b', ref: 'WB-2', title: 'Ускорить PDF', status: 'review' });
const stuck = taskDto({ id: 'c', ref: 'API-1', title: 'Выплаты через Stripe', status: 'blocked', blockReason: 'ждём одобрения Stripe', priority: 'urgent', dueOn: day(-2) });
const next = taskDto({ id: 'd', ref: 'WB-3', title: 'НДС для ЕС', priority: 'high', dueOn: day(0) });

const busy: OverviewDto = {
  projects: [
    project({
      counts: counts({ todo: 1, in_progress: 1, review: 1 }), doneThisWeek: 2,
      live: [{ id: 's1', ref: 'S-1', agentName: 'claude-code@mac', lastSeenAt: new Date().toISOString() }],
      inProgress: [doing], review: [check], next: [next],
    }),
    project({ id: 'p2', key: 'API', name: 'Сервер', counts: counts({ blocked: 1 }), blocked: [stuck] }),
    project({ id: 'p3', key: 'OLD', name: 'Лендинг', quiet: true, lastActivityAt: null }),
  ],
  attention: { review: [check], blocked: [stuck], dated: [stuck, next], proposals: 2 },
};

function mount(o: OverviewDto, review: unknown = { review: null, manager: { enabled: false, model: null } }) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => json(String(url) === '/api/ui/manager/review' ? review : o));
  return renderPage(<Routes><Route path="/" element={<Overview />} /><Route path="/board" element={<p>доска</p>} /></Routes>);
}
const tile = (label: string) => screen.getByText(label, { selector: '.tile-label' }).closest<HTMLElement>('.tile')!;
const card = (name: string) => screen.getByRole('heading', { name, level: 3 }).closest('article')!;

describe('Overview', () => {
  it('sums the work of all projects in the tiles, overdue counted in the browser’s own day', async () => {
    mount(busy);
    await screen.findByText('Ждёт тебя');
    expect(within(tile('В работе')).getByText('1')).toBeTruthy();
    expect(within(tile('В работе')).getByText('1 агент работает')).toBeTruthy();
    expect(within(tile('На проверке')).getByText('1')).toBeTruthy();
    expect(tile('Просрочено').className).toContain('is-danger');
    expect(within(tile('Готово за 7 дней')).getByText('2')).toBeTruthy();
  });

  it('lists what waits for the owner: checks, blockers with their reason, deadlines and proposals', async () => {
    mount(busy);
    const waiting = (await screen.findByText('Ждёт тебя')).closest('section')!;
    expect(within(waiting).getByText('ждём одобрения Stripe')).toBeTruthy();
    expect(within(waiting).getByText('Просрочено на 2 дня')).toBeTruthy();
    expect(within(waiting).getByText('Срок сегодня')).toBeTruthy();
    expect(within(waiting).getByRole('link', { name: /2 предложения посмотреть/ }).getAttribute('href')).toBe('/proposals');
    // a task opens in the drawer over the overview
    expect(within(waiting).getByRole('link', { name: 'Ускорить PDF' }).getAttribute('href')).toBe('/tasks/b');
  });

  it('shows each project as a card: live agents, who does what, what is next', async () => {
    mount(busy);
    await screen.findByRole('heading', { name: 'Web', level: 3 });
    const web = card('Web');
    expect(within(web).getByText('1 агент работает')).toBeTruthy();
    expect(within(web).getByRole('link', { name: 'Экспорт в CSV' }).getAttribute('title')).toContain('claude-code@mac');
    expect(within(web).getByRole('img').getAttribute('aria-label')).toBe('К выполнению: 1, В работе: 1, Заблокирована: 0, На проверке: 1');
    expect(within(web).getByText('2 готово за 7 дней')).toBeTruthy();
    expect(within(web).getByText('Срок сегодня')).toBeTruthy();
  });

  it('folds quiet projects away and opens the board filtered by a project', async () => {
    mount(busy);
    await screen.findByText('Ждёт тебя');
    expect(screen.getByText('Тихие проекты (1)')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Лендинг', level: 3 }).closest('details')).toBeTruthy();
    await userEvent.click(within(card('Сервер')).getByRole('button', { name: 'Открыть доску' }));
    expect(screen.getByText('доска')).toBeTruthy();
    expect(localStorage.getItem('conus.project')).toBe('API');
  });

  it('says so when nothing waits for the owner', async () => {
    mount({ projects: [project({ counts: counts({ todo: 1 }), next: [taskDto({ title: 'Спокойная задача' })] })], attention: { review: [], blocked: [], dated: [], proposals: 0 } });
    expect(await screen.findByText('Тебя ничего не ждёт. Агенты работают.')).toBeTruthy();
  });

  it('explains an empty Conus', async () => {
    mount({ projects: [], attention: { review: [], blocked: [], dated: [], proposals: 0 } });
    expect(await screen.findByText('Проектов пока нет')).toBeTruthy();
  });

  it('shows the manager: today’s focus, priority changes and notes, and runs a review on demand', async () => {
    const review = {
      id: 1, trigger: 'daily', model: 'claude-opus-5-5', summary: 'Сначала выплаты.', createdAt: new Date().toISOString(),
      focus: [{ taskId: 'c', ref: 'API-1', title: 'Выплаты через Stripe', why: 'клиент ждёт' }],
      changes: [{ taskId: 'd', ref: 'WB-3', title: 'НДС для ЕС', from: 'normal', to: 'high', reason: 'срок сегодня', applied: true }],
      findings: [{ kind: 'stale', refs: ['WB-2'], note: 'неделю без движения' }],
    };
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url) === '/api/ui/manager/review') return json({ review, manager: { enabled: true, model: 'claude-opus-5-5' } });
      if ((init as RequestInit | undefined)?.method === 'POST') return json({ review, manager: { enabled: true, model: 'claude-opus-5-5' } });
      return json(busy);
    });
    renderPage(<Routes><Route path="/" element={<Overview />} /></Routes>);
    const panel = await screen.findByRole('region', { name: 'Главный агент' });
    expect(within(panel).getByText('Сначала выплаты.')).toBeTruthy();
    expect(within(panel).getByRole('link', { name: /Выплаты через Stripe/ }).getAttribute('href')).toBe('/tasks/c');
    expect(within(panel).getByText('клиент ждёт')).toBeTruthy();
    expect(within(panel).getByText('Приоритеты изменены: 1')).toBeTruthy();
    expect(within(panel).getByText('Заметки (1)')).toBeTruthy();
    await userEvent.click(within(panel).getByRole('button', { name: 'Провести ревизию' }));
    await waitFor(() => expect(f.mock.calls.some(([u, i]) => String(u) === '/api/ui/manager/review' && (i as RequestInit)?.method === 'POST')).toBe(true));
  });

  it('explains what the manager needs when it is off', async () => {
    mount(busy);
    expect(await screen.findByText(/нужен ключ Anthropic API на сервере/)).toBeTruthy();
  });
});
