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
const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const counts = (over: Partial<ProjectOverviewDto['counts']> = {}) => ({ proposed: 0, todo: 0, in_progress: 0, blocked: 0, review: 0, ...over });
const project = (over: Partial<ProjectOverviewDto>): ProjectOverviewDto => ({
  id: 'p1', key: 'WB', name: 'Web', counts: counts(), doneThisWeek: 0, lastActivityAt: ago(0), lastAgentAt: ago(0), reviewSince: null, live: [],
  inProgress: [], blocked: [], review: [], next: [], quiet: false, ...over,
});

const doing = taskDto({ id: 'a', ref: 'WB-1', title: 'Экспорт в CSV', status: 'in_progress', holder: { agentName: 'claude-code@mac', sessionRef: 'S-1', sessionId: 's1' } });
const check = taskDto({ id: 'b', ref: 'WB-2', title: 'Ускорить PDF', status: 'review', updatedAt: ago(3.5) });
const stuck = taskDto({
  id: 'c', ref: 'API-1', projectKey: 'API', projectName: 'Сервер', title: 'Выплаты через Stripe', status: 'blocked',
  blockReason: 'ждём одобрения Stripe', priority: 'urgent', dueOn: day(-2),
});
const next = taskDto({ id: 'd', ref: 'WB-3', title: 'НДС для ЕС', priority: 'high', dueOn: day(0) });
const building = taskDto({
  id: 'e', ref: 'MOB-1', projectKey: 'MOB', projectName: 'Приложение', title: 'Экран оплаты', status: 'in_progress',
  holder: { agentName: 'codex@linux', sessionRef: 'S-2', sessionId: 's2' },
});
const queued = taskDto({ id: 'f', ref: 'DOC-1', projectKey: 'DOC', projectName: 'Документация', title: 'Описать API', priority: 'high' });

/** Two projects wait for the owner, one is being worked on, one stands idle, one has nothing open. */
const busy: OverviewDto = {
  projects: [
    project({
      counts: counts({ todo: 1, in_progress: 1, review: 1 }), doneThisWeek: 2, reviewSince: check.updatedAt,
      live: [{ id: 's1', ref: 'S-1', agentName: 'claude-code@mac', lastSeenAt: ago(0) }],
      inProgress: [doing], review: [check], next: [next],
    }),
    project({ id: 'p2', key: 'API', name: 'Сервер', counts: counts({ blocked: 1 }), blocked: [stuck], lastAgentAt: ago(30) }),
    project({
      id: 'p3', key: 'MOB', name: 'Приложение', counts: counts({ in_progress: 2 }), inProgress: [building],
      live: [{ id: 's2', ref: 'S-2', agentName: 'codex@linux', lastSeenAt: ago(0) }],
    }),
    project({ id: 'p4', key: 'DOC', name: 'Документация', counts: counts({ todo: 2, proposed: 1 }), next: [queued], lastAgentAt: ago(5) }),
    project({ id: 'p5', key: 'OLD', name: 'Лендинг', quiet: true, lastActivityAt: null, lastAgentAt: null }),
  ],
  attention: { review: [check], blocked: [stuck], dated: [stuck, next], proposals: 2 },
};
const calm: OverviewDto = {
  projects: [project({ counts: counts({ todo: 1 }), next: [taskDto({ title: 'Спокойная задача' })] })],
  attention: { review: [], blocked: [], dated: [], proposals: 0 },
};

const review = {
  id: 1, trigger: 'daily', model: 'claude-opus-5-5', summary: 'Сначала выплаты.', createdAt: new Date().toISOString(),
  focus: [{ taskId: 'c', ref: 'API-1', title: 'Выплаты через Stripe', why: 'клиент ждёт' }],
  changes: [{ taskId: 'd', ref: 'WB-3', title: 'НДС для ЕС', from: 'normal', to: 'high', reason: 'срок сегодня', applied: true }],
  findings: [{ kind: 'stale', refs: ['WB-2'], note: 'неделю без движения' }],
};
const managed = { review, manager: { enabled: true, model: 'claude-opus-5-5' } };

function mount(o: OverviewDto, manager: unknown = { review: null, manager: { enabled: false, model: null } }) {
  const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => json(String(url) === '/api/ui/manager/review' ? manager : o));
  renderPage(<Routes><Route path="/" element={<Overview />} /><Route path="/board" element={<p>доска</p>} /></Routes>);
  return f;
}
/** The project's name is the button that opens its row. */
const toggle = (name: string) => screen.getByRole('button', { name });
const row = (name: string) => toggle(name).closest<HTMLElement>('li')!;
const group = (name: string) => screen.getByRole('region', { name });

describe('Overview', () => {
  it('answers «what needs me?» in one line, with the totals behind it; overdue is counted in the browser’s own day', async () => {
    mount(busy);
    expect(await screen.findByText('Тебя ждут 2 проекта')).toBeTruthy();
    expect(screen.getByText('1 на проверке')).toBeTruthy();
    expect(screen.getByText('1 заблокировано')).toBeTruthy();
    expect(screen.getByText('1 просрочено')).toBeTruthy();
    expect(screen.getByText('Агенты работают в 2 проектах')).toBeTruthy();
    expect(screen.getByText('Готово за 7 дней: 2')).toBeTruthy();
    expect(screen.getByRole('link', { name: /2 предложения посмотреть/ }).getAttribute('href')).toBe('/proposals');
  });

  it('groups the projects by what they ask of the owner, and keeps the ones without tasks folded', async () => {
    mount(busy);
    await screen.findByText('Тебя ждут 2 проекта');
    expect(within(group('Ждут тебя')).getAllByRole('listitem').map((li) => within(li).getByRole('button', { expanded: false }).textContent))
      .toEqual(['Web', 'Сервер']);
    expect(within(group('В работе')).getByRole('button', { name: 'Приложение' })).toBeTruthy();
    expect(within(group('Простаивают')).getByRole('button', { name: 'Документация' })).toBeTruthy();
    const empty = group('Без задач');
    expect(within(empty).queryByRole('button', { name: 'Лендинг' })).toBeNull();
    await userEvent.click(within(empty).getByRole('button', { name: 'Без задач' }));
    expect(within(empty).getByRole('button', { name: 'Лендинг' })).toBeTruthy();
    expect(row('Лендинг').textContent).toContain('Открытых задач нет');
    expect(within(row('Лендинг')).getByTitle('Агенты сюда ещё не заходили')).toBeTruthy();
  });

  it('says in one line what goes on in a project: what waits and for how long, who works, what is next', async () => {
    mount(busy);
    await screen.findByText('Тебя ждут 2 проекта');

    const web = row('Web');
    expect(within(web).getByRole('link', { name: 'Ускорить PDF' }).getAttribute('href')).toBe('/tasks/b');
    expect(web.textContent).toContain('Ускорить PDF · ждёт 3 ч');
    expect(within(web).getByText('На проверке: 1')).toBeTruthy();
    expect(within(web).getByText('сейчас')).toBeTruthy();
    expect(web.textContent).toContain('В очереди: 1');
    expect(web.textContent).toContain('Готово · 7 д: 2');

    // a blocker comes before everything else, with its reason
    const server = row('Сервер');
    expect(server.textContent).toContain('Выплаты через Stripe — ждём одобрения Stripe');
    expect(within(server).getByText('Заблокировано: 1')).toBeTruthy();
    expect(within(server).getByText('Просрочено: 1')).toBeTruthy();
    expect(within(server).getByText('вчера')).toBeTruthy();

    const app = row('Приложение');
    expect(within(app).getByRole('link', { name: 'Экран оплаты' }).getAttribute('href')).toBe('/tasks/e');
    expect(app.textContent).toContain('Экран оплаты · и ещё 1');

    const docs = row('Документация');
    expect(within(docs).getByText('Дальше:')).toBeTruthy();
    expect(within(docs).getByRole('link', { name: 'Описать API' }).getAttribute('href')).toBe('/tasks/f');
    expect(within(docs).getByText('Предложений: 1')).toBeTruthy();
    expect(within(docs).getByText('5 ч назад')).toBeTruthy();
  });

  it('opens a project into its tasks: what to check, what is blocked and why, deadlines, who works there', async () => {
    mount(busy);
    await screen.findByText('Тебя ждут 2 проекта');
    expect(toggle('Web').getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(toggle('Web'));
    expect(toggle('Web').getAttribute('aria-expanded')).toBe('true');

    const web = row('Web');
    expect(within(web).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Проверить1', 'В работе1', 'Дальше по плану1']);
    // a task opens in the drawer over the overview
    expect(within(web).getAllByRole('link', { name: 'Ускорить PDF' }).map((a) => a.getAttribute('href'))).toEqual(['/tasks/b', '/tasks/b']);
    expect(within(web).getByRole('link', { name: 'Экспорт в CSV' }).getAttribute('href')).toBe('/tasks/a');
    expect(within(web).getByText('Срок сегодня')).toBeTruthy();
    expect(within(web).getByText('1 агент работает')).toBeTruthy();
    expect(within(web).getByRole('link', { name: 'claude-code@mac · S-1' }).getAttribute('href')).toBe('/sessions/s1');

    await userEvent.click(toggle('Сервер'));
    const server = row('Сервер');
    expect(within(server).getByText('ждём одобрения Stripe')).toBeTruthy();
    expect(within(server).getByText('Просрочено на 2 дня')).toBeTruthy();
    expect(within(server).getByText('Агент был в проекте вчера')).toBeTruthy();

    await userEvent.click(toggle('Web'));
    expect(within(row('Web')).queryByRole('heading', { level: 3 })).toBeNull();
    expect(within(row('Сервер')).getByRole('heading', { level: 3 })).toBeTruthy();
  });

  it('opens the board filtered by a project straight from its row', async () => {
    mount(busy);
    await userEvent.click(await screen.findByRole('button', { name: 'Доска проекта Сервер' }));
    expect(screen.getByText('доска')).toBeTruthy();
    expect(localStorage.getItem('conus.project')).toBe('API');
  });

  it('opens the board from an opened project too', async () => {
    mount(busy);
    await userEvent.click(await screen.findByRole('button', { name: 'Документация' }));
    expect(within(row('Документация')).getByRole('link', { name: '1 предложение посмотреть' }).getAttribute('href')).toBe('/proposals');
    await userEvent.click(within(row('Документация')).getByRole('button', { name: 'Открыть доску' }));
    expect(screen.getByText('доска')).toBeTruthy();
    expect(localStorage.getItem('conus.project')).toBe('DOC');
  });

  it('says so when nothing waits for the owner', async () => {
    mount(calm);
    expect(await screen.findByText('Тебя ничего не ждёт')).toBeTruthy();
    expect(screen.getByText('Сейчас агенты не работают')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Ждут тебя' })).toBeNull();
    expect(within(group('Простаивают')).getByRole('link', { name: 'Спокойная задача' })).toBeTruthy();
  });

  it('explains an empty Conus', async () => {
    mount({ projects: [], attention: { review: [], blocked: [], dated: [], proposals: 0 } });
    expect(await screen.findByText('Проектов пока нет')).toBeTruthy();
  });

  it('shows the manager: today’s focus, priority changes and notes, and runs a review on demand', async () => {
    const f = mount(busy, managed);
    const panel = await screen.findByRole('region', { name: 'Главный агент' });
    expect(within(panel).getByText('Сначала выплаты.')).toBeTruthy();
    expect(within(panel).getByRole('link', { name: /Выплаты через Stripe/ }).getAttribute('href')).toBe('/tasks/c');
    expect(within(panel).getByText('клиент ждёт')).toBeTruthy();
    expect(within(panel).getByText('Приоритеты изменены: 1')).toBeTruthy();
    expect(within(panel).getByText('Заметки (1)')).toBeTruthy();
    await userEvent.click(within(panel).getByRole('button', { name: 'Провести ревизию' }));
    await waitFor(() => expect(f.mock.calls.some(([u, i]) => String(u) === '/api/ui/manager/review' && (i as RequestInit)?.method === 'POST')).toBe(true));
  });

  it('folds the manager into one line and remembers it', async () => {
    mount(busy, managed);
    const panel = await screen.findByRole('region', { name: 'Главный агент' });
    await userEvent.click(within(panel).getByRole('button', { name: 'Свернуть' }));
    expect(within(panel).queryByText('клиент ждёт')).toBeNull();
    expect(within(panel).getByText('Сначала выплаты.')).toBeTruthy();
    expect(localStorage.getItem('conus.manager.collapsed')).toBe('1');
    await userEvent.click(within(panel).getByRole('button', { name: 'Развернуть' }));
    expect(within(panel).getByText('клиент ждёт')).toBeTruthy();
    expect(localStorage.getItem('conus.manager.collapsed')).toBe('0');
  });

  it('starts the manager folded on a phone, until the owner unfolds it', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('max-width: 640px'), media: q, addEventListener() {}, removeEventListener() {} }));
    try {
      mount(busy, managed);
      const panel = await screen.findByRole('region', { name: 'Главный агент' });
      expect(within(panel).queryByText('клиент ждёт')).toBeNull();
      expect(localStorage.getItem('conus.manager.collapsed')).toBeNull();
      await userEvent.click(within(panel).getByRole('button', { name: 'Развернуть' }));
      expect(within(panel).getByText('клиент ждёт')).toBeTruthy();
      expect(localStorage.getItem('conus.manager.collapsed')).toBe('0');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the manager folded on the next visit', async () => {
    localStorage.setItem('conus.manager.collapsed', '1');
    mount(busy, managed);
    const panel = await screen.findByRole('region', { name: 'Главный агент' });
    expect(within(panel).getByRole('button', { name: 'Развернуть' }).getAttribute('aria-expanded')).toBe('false');
    expect(within(panel).queryByText('клиент ждёт')).toBeNull();
  });

  it('explains what the manager needs when it is off', async () => {
    mount(busy);
    expect(await screen.findByText(/нужен ключ Anthropic API на сервере/)).toBeTruthy();
  });
});
