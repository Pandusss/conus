import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { apiError, json, renderPage } from '../test-utils';
import { SessionPage } from './SessionPage';

afterEach(() => vi.restoreAllMocks());

const ID = '22222222-2222-4222-8222-222222222222';
const overview = {
  session: {
    id: ID, ref: 'S-1', agentName: 'claude-code@laptop', projectKey: 'WB', state: 'ended', branch: 'main', startedAt: '2026-10-08T10:00:00Z',
    lastSeenAt: '2026-10-08T11:00:00Z', endedAt: '2026-10-08T11:00:00Z', taskOps: 2, nudges: 2, nudgesActed: 1, janitorReleases: 0,
  },
  events: [],
  nudges: [
    { rule: 'D1', reason: 'Есть правки без задачи', acted: true, createdAt: '2026-10-08T10:30:00Z' },
    { rule: 'JUDGE', reason: 'Похоже на решение', acted: false, createdAt: '2026-10-08T10:40:00Z' },
  ],
  janitor: [],
};
const mount = () => renderPage(<SessionPage />, { route: '/sessions/:id', path: `/sessions/${ID}` });

describe('SessionPage', () => {
  it('shows nudge rules by their Russian names', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json(overview));
    mount();
    expect(await screen.findByText(/незакреплённая работа/)).toBeTruthy();
    expect(screen.getByText(/судья/)).toBeTruthy();
    expect(screen.queryByText(/JUDGE/)).toBeNull();
  });

  it('says "not found" instead of loading forever for an unknown session', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => apiError(404, 'not_found', 'Session not found.'));
    mount();
    expect((await screen.findByRole('alert')).textContent).toBe('Не найдено');
    expect(screen.queryByText('Загрузка…')).toBeNull();
  });
});
